#!/usr/bin/env python3
"""Reproducible portable skill package; runtime/private data is outside the allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP = {'SKILL.md', 'package.json', 'package-lock.json', 'requirements.txt', '使用说明.txt', 'README.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md'}
DIRS = {'agents', 'scripts', 'references', 'templates', 'tests', 'community-server'}
EXTENSIONS = {'.md', '.json', '.yaml', '.yml', '.mjs', '.py', '.txt', '.service', '.html'}


def package(output):
    files = []
    candidates = [ROOT / name for name in TOP]
    for name in DIRS:
        folder = ROOT / name
        if folder.exists() and not folder.is_symlink():
            candidates.extend(folder.rglob('*'))
    for p in candidates:
        rel = p.relative_to(ROOT)
        if p.is_symlink() or not p.is_file() or '__pycache__' in rel.parts:
            continue
        if len(rel.parts) == 1 and p.name in TOP or rel.parts[0] in DIRS and p.suffix in EXTENSIONS and not p.name.endswith('.bak'):
            files.append((rel.as_posix(), p.read_bytes()))
    files.sort()
    metadata = json.loads((ROOT / 'package.json').read_text())
    manifest = {'name': 'k12-ai-grading', 'version': metadata['version'], 'files': [
        {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files]}
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix('.tmp')
    with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in files + [('PACKAGE-MANIFEST.json', (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode())]:
            info = zipfile.ZipInfo('k12-ai-grading/'+name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    temp.replace(output)
    result = {'name':manifest['name'], 'version':manifest['version'], 'archive':output.name,
              'file_count': len(files)+1, 'bytes':output.stat().st_size,
              'sha256':hashlib.sha256(output.read_bytes()).hexdigest(), 'runtime_data_included':False}
    output.with_name('package-manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    print(json.dumps(package(parser.parse_args().output.resolve()), ensure_ascii=False, indent=2))
