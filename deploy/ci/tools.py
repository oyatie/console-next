#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Install only checksum-locked upstream binaries; never execute download scripts."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
import tarfile
import time
import urllib.error
import urllib.request


def verified(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('PLAT_TOOL_CHECKSUM: downloaded bytes differ from versions.json')
    return data


def fetch(url, attempts=4):
    # Release hosts answer 5xx/timeouts transiently; 4xx and checksum mismatches stay fatal.
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(url, timeout=120).read()
        except (urllib.error.URLError, TimeoutError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code < 500 or attempt == attempts - 1:
                raise
            print(f'retry {attempt + 1}/{attempts - 1} after {error}', file=sys.stderr, flush=True)
            time.sleep(2 ** (attempt + 1))


def install(name, item, destination):
    data = verified(fetch(item['url']), item['sha256'])
    if item['url'].endswith('.tar.gz'):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            member = next(m for m in archive.getmembers() if m.isfile() and Path(m.name).name == name)
            data = archive.extractfile(member).read()
    destination.joinpath(name).write_bytes(data)
    destination.joinpath(name).chmod(0o755)


if __name__ == '__main__':
    lock = json.loads(Path(__file__).parents[1].joinpath('versions.json').read_text())
    target = platform.system().lower() + '-' + {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]
    destination = Path(os.environ.get('PLATFORM_BIN', '.tmp/platform/bin')).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or lock['tools']:
        install(name, lock['tools'][name]['files'][target], destination)
        print(f'{name}: {lock["tools"][name]["version"]}', flush=True)
    if os.environ.get('GITHUB_PATH'):
        with open(os.environ['GITHUB_PATH'], 'a') as output:
            output.write(str(destination) + '\n')
