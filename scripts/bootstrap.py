#!/usr/bin/env python3
"""Agent entry: inspect first; --repair installs only this skill's private dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def configuration_lock(home):
    """OS releases the lock on interruption; never guess whether another process is dead."""
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = home / '.environment.lock'
    with lock_path.open('a+b') as handle:
        if os.name != 'nt':
            lock_path.chmod(0o600)
        if handle.seek(0, 2) == 0:
            handle.write(b'0')
            handle.flush()
        deadline = time.monotonic() + 55
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('另一实例正在配置环境，请智能体稍后重试；不重复安装。')
                time.sleep(0.15)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def data_home():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home()))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library/Application Support'
    else:
        base = Path.home() / '.local/share'
    return base / 'k12-ai-grading'


def load_previous_state(state_file):
    try:
        value = json.loads(state_file.read_text()) if state_file.exists() else {}
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        # A cache is reproducible. Repair by probing again, not by trusting partial JSON.
        return {}


def run(args, **kwargs):
    result = subprocess.run([str(x) for x in args], cwd=ROOT, capture_output=True,
                            text=True, timeout=kwargs.pop('timeout', 180), **kwargs)
    if result.returncode:
        # No command output gets copied into a report; it may contain local paths.
        raise RuntimeError('配置命令失败：' + Path(str(args[0])).name + '；请智能体在本地检查，不要求教师处理依赖。')
    return result.stdout.strip()


def inspect(home, repair=False, browser_probe=True, force_probe=False):
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        home.chmod(0o700)
    state_file = home / 'environment.json'
    previous = load_previous_state(state_file)
    node = shutil.which('node')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if node:
        node = str(Path(node).resolve())
    missing, changed = [], []
    if sys.version_info < (3, 11):
        missing.append('Python>=3.11')
    if not node or int(run([node, '--version']).lstrip('v').split('.')[0]) < 20:
        missing.append('Node.js>=20')
    if not npm:
        missing.append('npm')
    if missing:
        return {'ready': False, 'missing': missing, 'repair_requires_runtime': True,
                'message': '由智能体用系统已有的官方运行时管理器安装缺失项后重试；系统密码/设备许可由教师完成。不要让教师运行命令。'}
    sharing = json.loads(run([node, ROOT / 'scripts/workflow.mjs', 'sharing-status', '--home', home], timeout=10))
    fingerprint = hashlib.sha256((str(node) + run([node, '--version']) +
                                  (ROOT / 'package-lock.json').read_text() +
                                  (ROOT / 'requirements.txt').read_text()).encode()).hexdigest()
    installed_node = ROOT / 'node_modules/playwright/package.json'
    expected_node = json.loads((ROOT / 'package.json').read_text())['dependencies']['playwright']
    node_ok = installed_node.exists() and json.loads(installed_node.read_text()).get('version') == expected_node
    if not node_ok or previous.get('fingerprint') != fingerprint:
        if repair:
            run([npm, 'ci', '--no-audit', '--no-fund'], timeout=300)
            changed.append('Playwright依赖')
        else:
            missing.append('当前版本Node依赖核验')
    venv = home / 'python'
    python = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    expected = dict(line.strip().split('==') for line in (ROOT / 'requirements.txt').read_text().splitlines() if line.strip())
    dep_probe = "import importlib.metadata,json;import PIL.Image,pypdf,docx,pymupdf;print(json.dumps({n:importlib.metadata.version(n) for n in " + repr(list(expected)) + "}))"
    try:
        installed = json.loads(run([python, '-c', dep_probe]))
        if installed != expected:
            raise RuntimeError('版本不一致')
    except (RuntimeError, OSError):
        if repair:
            if not python.exists():
                run([sys.executable, '-m', 'venv', venv])
            run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '-r', ROOT / 'requirements.txt'], timeout=300)
            installed = json.loads(run([python, '-c', dep_probe]))
            changed.append('独立Python环境与依赖')
        else:
            missing.append('Python阅卷依赖')
            installed = {}
    # Actual launch, not just a binary-path check; reuse the result for up to 30 days.
    channel = previous.get('browser_channel', 'chrome')
    probe_due = bool(force_probe or changed or previous.get('fingerprint') != fingerprint or
                     time.time() - previous.get('browser_checked_at', 0) > 30 * 86400)
    browser_ok = previous.get('browser_ok', False)
    if browser_probe and probe_due and not missing:
        probe = "import {chromium} from 'playwright'; const b=await chromium.launch({headless:true,channel:process.argv[1]||undefined});await b.close();"
        browser_ok = False
        for candidate in [channel, 'chrome', 'msedge', '']:
            try:
                run([node, '--input-type=module', '-e', probe, candidate], timeout=40)
                channel, browser_ok = candidate, True
                break
            except RuntimeError:
                continue
        if not browser_ok and repair:
            run([node, ROOT / 'node_modules/playwright/cli.js', 'install', 'chromium'], timeout=300)
            run([node, '--input-type=module', '-e', probe, ''], timeout=40)
            channel, browser_ok = '', True
            changed.append('Playwright Chromium浏览器')
        if not browser_ok:
            missing.append('可启动的自动化浏览器')
    if not browser_probe:
        browser_ok = False
        missing.append('浏览器尚未实测')
    ready = not missing and browser_ok
    result = {'ready': ready, 'missing': missing, 'changed': changed, 'sharing': sharing,
              'node': node, 'python': str(python), 'python_packages': installed,
              'browser_channel': channel, 'browser_ok': browser_ok,
              'browser_checked_at': time.time() if browser_probe and browser_ok and probe_due else previous.get('browser_checked_at', 0),
              'fingerprint': fingerprint, 'checked_at': time.time(),
              'configured_once': previous.get('configured_once', False) or ready,
              'teacher_notice': '首次配置完成：一次配置，长期使用。以后由我检查环境，你只需登录和给题。' if ready and not previous.get('configured_once') else ''}
    temp = state_file.with_name('environment.' + uuid.uuid4().hex + '.tmp')
    with temp.open('w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    if os.name != 'nt':
        temp.chmod(0o600)
    temp.replace(state_file)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repair', action='store_true')
    parser.add_argument('--home', type=Path, default=data_home())
    parser.add_argument('--force-browser', action='store_true')
    args = parser.parse_args()
    try:
        with configuration_lock(args.home):
            result = inspect(args.home, args.repair, force_probe=args.force_browser)
    except Exception as exc:
        result = {'ready': False, 'error': str(exc), 'message': '保留现有配置，由智能体修复后再开卷。'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result['ready'] else 2)
