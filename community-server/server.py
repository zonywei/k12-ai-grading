#!/usr/bin/env python3
"""Controlled K12 contribution intake. Standard library only; never accepts exams."""
import argparse
import base64
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import threading
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / 'references/community/service.json').read_text())
VOCAB = json.loads((ROOT / 'references/community/vocabulary.json').read_text())
MAX_BODY = 16384
MAX_ROWS = 100000
RETENTION_DAYS = 180
FIELDS = {'key', 'schema_version', 'skill_version', 'subject', 'stage', 'improvements'}
STAGES = {'primary', 'middle', 'high', 'general'}


def canonical(payload):
    if not isinstance(payload, dict) or set(payload) != FIELDS:
        raise ValueError('schema')
    if type(payload['schema_version']) is not int or payload['schema_version'] != 1:
        raise ValueError('version')
    if not isinstance(payload['skill_version'], str) or not re.fullmatch(r'[1-9]\d{0,2}\.\d{1,3}\.\d{1,3}', payload['skill_version']):
        raise ValueError('version')
    if payload['subject'] not in VOCAB['subjects'] or payload['stage'] not in STAGES:
        raise ValueError('scope')
    rows = payload['improvements']
    if not isinstance(rows, list) or not 1 <= len(rows) <= 12:
        raise ValueError('rows')
    clean = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'code', 'synthetic_check'}:
            raise ValueError('row')
        if row['code'] not in VOCAB['improvement_codes'] or row['synthetic_check'] not in VOCAB['synthetic_checks']:
            raise ValueError('vocabulary')
        clean.append({'code': row['code'], 'synthetic_check': row['synthetic_check']})
    clean.sort(key=lambda r: (r['code'], r['synthetic_check']))
    body = {'schema_version': 1, 'skill_version': payload['skill_version'], 'subject': payload['subject'], 'stage': payload['stage'], 'improvements': clean}
    encoded = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
    key = hashlib.sha256(encoded.encode()).hexdigest()
    if not isinstance(payload['key'], str) or not hmac.compare_digest(key, payload['key']):
        raise ValueError('key')
    return key, encoded


class Intake:
    def __init__(self, db, limit=60, global_limit=300):
        self.db = Path(db)
        self.db.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.limit, self.global_limit = limit, global_limit
        self.salt = secrets.token_bytes(32)
        self.lock = threading.Lock()
        self.windows = defaultdict(deque)
        self.last_prune = 0
        with self.connect() as con:
            con.execute('PRAGMA journal_mode=WAL')
            con.execute('CREATE TABLE IF NOT EXISTS contributions (key TEXT PRIMARY KEY, body TEXT NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT "pending")')
        os.chmod(self.db, 0o600)
        self.prune()

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.db, timeout=3)
        try:
            with con:
                yield con
        finally:
            con.close()

    def allowed(self, address):
        now = time.monotonic()
        # IP is only used as an ephemeral, per-process salted bucket; never stored.
        bucket = hmac.new(self.salt, address.encode(), hashlib.sha256).hexdigest()
        with self.lock:
            for key in list(self.windows):
                q = self.windows[key]
                while q and q[0] <= now - 60:
                    q.popleft()
                if not q:
                    del self.windows[key]
            if len(self.windows['global']) >= self.global_limit or len(self.windows[bucket]) >= self.limit:
                return False
            self.windows['global'].append(now)
            self.windows[bucket].append(now)
            return True

    def accept(self, key, body):
        with self.connect() as con:
            con.execute('BEGIN IMMEDIATE')
            if con.execute('SELECT 1 FROM contributions WHERE key=?', (key,)).fetchone():
                return True
            if con.execute('SELECT COUNT(*) FROM contributions').fetchone()[0] >= MAX_ROWS:
                raise OverflowError('capacity')
            con.execute('INSERT INTO contributions(key,body,received_at) VALUES (?,?,?)', (key, body, int(time.time())))
        return False

    def prune(self):
        if time.monotonic() - self.last_prune < 3600 and self.last_prune:
            return
        with self.connect() as con:
            con.execute('DELETE FROM contributions WHERE received_at < ?', (int(time.time()) - RETENTION_DAYS * 86400,))
        self.last_prune = time.monotonic()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    allow_reuse_address = True

    def __init__(self, address, intake, downloads=None):
        self.intake = intake
        self.downloads = Path(downloads).resolve() if downloads else None
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # No request/body/IP/headers/credentials in service logs.
        pass

    def service_actions(self):
        try:
            self.intake.prune()
        except sqlite3.Error:
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'K12Community/1'

    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def log_message(self, *args):
        pass

    def send(self, status, value, content_type='application/json; charset=utf-8', script_hashes=()):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode() if isinstance(value, dict) else value.encode() if isinstance(value, str) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        csp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        if script_hashes:
            csp += '; script-src ' + ' '.join("'sha256-" + value + "'" for value in script_hashes)
        self.send_header('Content-Security-Policy', csp)
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/health':
            try:
                with self.server.intake.connect() as con:
                    con.execute('SELECT 1 FROM contributions LIMIT 1').fetchone()
                return self.send(200, {'ok': True, 'service': 'k12-grading-community', 'schema_version': 1, 'notice_version': POLICY['notice_version']})
            except sqlite3.Error:
                return self.send(503, {'ok': False})
        if route == '/':
            version = '当前版本'
            link = '/downloads/latest.json'
            if self.server.downloads:
                latest = self.server.downloads / 'latest.json'
                try:
                    value = json.loads(latest.read_text())['version']
                    if re.fullmatch(r'[1-9]\d{0,2}\.\d{1,3}\.\d{1,3}', value):
                        version = 'v' + value
                        link = '/downloads/k12-ai-grading-v' + value + '.zip'
                except (OSError, ValueError, TypeError, KeyError):
                    pass
            page = (ROOT / 'community-server/home.html').read_text(encoding='utf-8')
            return self.send(200, page.replace('__VERSION__', version).replace('__DOWNLOAD_URL__', link), 'text/html; charset=utf-8')
        if route == '/privacy':
            import html
            blocks = []
            for block in (ROOT / 'PRIVACY.md').read_text(encoding='utf-8').split('\n\n'):
                if block.startswith('# '):
                    continue
                blocks.append('<h2>' + html.escape(block[3:]) + '</h2>' if block.startswith('## ') else '<p>' + html.escape(block) + '</p>')
            page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隐私与自愿共享说明</title><style>body{max-width:820px;margin:40px auto;padding:0 24px;font:17px/1.8 system-ui;color:#26382d}h1{font-size:31px}h2{font-size:23px;margin-top:32px}p{overflow-wrap:anywhere}a{color:#315f43}</style><nav><a href="/">返回技能首页</a> · <a href="https://github.com/zonywei/k12-ai-grading">公开源码</a></nav><h1>隐私与自愿共享说明</h1>' + ''.join(blocks) + '</html>'
            return self.send(200, page, 'text/html; charset=utf-8')
        if route.startswith('/downloads/') and self.server.downloads:
            name = route.removeprefix('/downloads/')
            if not re.fullmatch(r'(?:latest\.json|k12-ai-grading-v\d+\.\d+\.\d+\.zip|K12-default-rules\.html)', name):
                return self.send(404, {'error': 'not_found'})
            file = self.server.downloads / name
            if file.is_file() and not file.is_symlink() and file.stat().st_size <= 5 * 1024 * 1024:
                mime = 'application/zip' if name.endswith('.zip') else 'text/html; charset=utf-8' if name.endswith('.html') else 'application/json; charset=utf-8'
                data = file.read_bytes()
                scripts = re.findall(rb'<script(?:\s[^>]*)?>(.*?)</script>', data, re.DOTALL) if name.endswith('.html') else []
                hashes = [base64.b64encode(hashlib.sha256(script).digest()).decode() for script in scripts]
                return self.send(200, data, mime, hashes)
        self.send(404, {'error': 'not_found'})

    def do_POST(self):
        if urlsplit(self.path).path != '/api/v1/contributions' or urlsplit(self.path).query:
            return self.send(404, {'error': 'not_found'})
        address = self.client_address[0]
        # Only a loopback tunnel may supply the forwarding IP; never accept it from remote peers.
        if address in {'127.0.0.1', '::1'}:
            address = self.headers.get('CF-Connecting-IP', address)[:64]
        if not self.server.intake.allowed(address):
            return self.send(429, {'error': 'rate_limited'})
        lengths = self.headers.get_all('Content-Length') or []
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,6}', lengths[0]) or self.headers.get('Transfer-Encoding'):
            return self.send(400, {'error': 'content_length_required'})
        length = int(lengths[0])
        if not 0 < length <= MAX_BODY:
            return self.send(413, {'error': 'payload_too_large'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.send(415, {'error': 'json_required'})
        if self.headers.get('X-K12-Sharing-Policy') != POLICY['notice_version']:
            return self.send(403, {'error': 'current_sharing_policy_required'})
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete')
            def unique_pairs(pairs):
                obj = {}
                for key, value in pairs:
                    if key in obj:
                        raise ValueError('duplicate_fields')
                    obj[key] = value
                return obj
            payload = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs)
            key, body = canonical(payload)
            if self.headers.get_all('Idempotency-Key') != [key]:
                raise ValueError('idempotency_header')
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            return self.send(400, {'error': 'invalid_controlled_payload'})
        try:
            duplicate = self.server.intake.accept(key, body)
        except (sqlite3.Error, OverflowError):
            return self.send(503, {'error': 'temporarily_unavailable'})
        self.send(200 if duplicate else 201, {'accepted': True, 'key': key, 'duplicate': duplicate, 'status': 'pending_review'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3020)
    parser.add_argument('--db', required=True)
    parser.add_argument('--downloads')
    parser.add_argument('--rate-limit', type=int, default=60)
    args = parser.parse_args()
    os.umask(0o077)
    server = Server((args.host, args.port), Intake(args.db, limit=args.rate_limit), args.downloads)
    print(json.dumps({'listening': server.server_address[0], 'port': server.server_address[1]}), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
