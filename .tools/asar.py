#!/usr/bin/env python3
"""Minimal read-only ASAR reader: ls / cat / grep inside an Electron asar archive.

The archive path is taken from, in order:
  1. the ``DSH_ASAR`` environment variable,
  2. the first existing candidate of the common macOS desktop installs.

Usage:
  python3 asar.py ls   [path-prefix]
  python3 asar.py cat  <exact-path-inside-archive>
  python3 asar.py grep <regex> [path-prefix]

Enumerate file paths inside the DSH installation with `ls dsh/node_modules/@deepseek-ai/`.
"""
import json
import os
import re
import struct
import sys

ARCHIVE_CANDIDATES = (
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    os.path.expanduser('~/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'),
)


def resolve_archive():
    """Return the asar path from DSH_ASAR or the known desktop install locations."""
    override = os.environ.get('DSH_ASAR')
    if override:
        if not os.path.isfile(override):
            raise SystemExit(f'DSH_ASAR does not point at a file: {override}')
        return override
    for candidate in ARCHIVE_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    raise SystemExit(
        'Could not find app.asar. Set DSH_ASAR=/path/to/app.asar, e.g.\n'
        '  DSH_ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" python3 asar.py ls dsh/'
    )


def load_index():
    """Parse the archive header and return (json header, data base offset)."""
    archive = resolve_archive()
    with open(archive, 'rb') as f:
        head = f.read(16)
        if len(head) < 16:
            raise SystemExit('bad archive: header shorter than 16 bytes')
        # uint32: 4 | uint32: header pickle size | uint32: +4 | uint32: json size
        (_, pickle_size, _, json_size) = struct.unpack('<IIII', head[:16])
        raw = f.read(json_size)
    base = 8 + pickle_size
    return archive, json.loads(raw.decode('utf-8')), base


def walk(node, prefix=''):
    """Yield (path, metadata) for every file entry."""
    for name, meta in node.get('files', {}).items():
        path = f'{prefix}/{name}' if prefix else name
        if 'files' in meta:
            yield from walk(meta, path)
        else:
            yield path, meta


def cmd_ls(prefix):
    _, header, _ = load_index()
    for path in sorted(p for p, _ in walk(header) if p.startswith(prefix)):
        print(path)


def cmd_cat(want):
    archive, header, base = load_index()
    for path, meta in walk(header):
        if path == want:
            with open(archive, 'rb') as f:
                f.seek(base + int(meta['offset']))
                sys.stdout.buffer.write(f.read(int(meta['size'])))
            return
    raise SystemExit(f'not found: {want}')


def cmd_grep(pattern, prefix=''):
    archive, header, base = load_index()
    rx = re.compile(pattern)
    text_extensions = ('.js', '.ts', '.json', '.yml', '.yaml', '.md', '.css', '.d.ts')
    with open(archive, 'rb') as f:
        for path, meta in walk(header):
            if not path.startswith(prefix) or not path.endswith(text_extensions):
                continue
            size = int(meta['size'])
            if size > 4_000_000:
                continue
            f.seek(base + int(meta['offset']))
            try:
                text = f.read(size).decode('utf-8')
            except UnicodeDecodeError:
                continue
            hits = [(number, line[:300]) for number, line in enumerate(text.splitlines(), 1) if rx.search(line)]
            if hits:
                print(f'=== {path} ({len(hits)} hits)')
                for number, line in hits[:8]:
                    print(f'  {number}: {line}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__.strip())
    command = sys.argv[1]
    if command == 'ls':
        cmd_ls(sys.argv[2] if len(sys.argv) > 2 else '')
    elif command == 'cat':
        if len(sys.argv) < 3:
            raise SystemExit('usage: asar.py cat <path-inside-archive>')
        cmd_cat(sys.argv[2])
    elif command == 'grep':
        if len(sys.argv) < 3:
            raise SystemExit('usage: asar.py grep <regex> [path-prefix]')
        cmd_grep(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '')
    else:
        raise SystemExit(f'unknown command: {command}')
