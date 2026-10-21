"""Validate the scoped grade walk without treating uncaptured frames as passing."""
import json
import re
import struct
import subprocess
from pathlib import Path

from report import DESIGN, vertical

ROOT = Path('docs/design/regression/parity-2026-10-12-grade')
BASELINE = 'bc04bd726a7f89d066f7225935264c8b539539f0'
NAMES = {'E1-roster', 'E2-card', 'E2-history', 'E4-grade-initial',
         'E4-grade-change', 'E4-multi', 'E5-menu', 'E6-promote', 'C-empty'}


def base_name(name):
    return re.sub(r'--(dark|light|firefox|full)', '', name)


def validate(frame, png, targets):
    assert frame in targets, 'Unknown or out-of-scope frame'
    f = targets[frame]
    assert png[:8] == b'\x89PNG\r\n\x1a\n', 'Not a PNG'
    assert struct.unpack('>II', png[16:24]) == (f['width'], f['height']), 'Wrong dimensions'


def reject(call):
    try:
        call()
    except AssertionError:
        return
    raise AssertionError('Negative control was accepted')


def gap(name):
    if name.startswith('E1-'):
        return ('Roster still shows 직위 rather than the ideal separate 직급 column; one-person evidence does not establish scale, shared scope or saved-view parity.', 'BL-027 / BL-028 / BL-120 / PW-001')
    if name.startswith('E4-grade-change'):
        return ('Inline grade creation, real write/read-back and period preview now work; future interval, overlap, dependency and full-shell parity remain unproved.', 'BL-086 / BL-088 / PW-001–003')
    if name.startswith('E4-grade-initial'):
        return ('Distinct 변경/정정 choices work; compact framed geometry, complete dated-history and shared-shell parity remain incomplete.', 'BL-086 / PW-001–003')
    if name.startswith(('E4-multi', 'C-empty')):
        return ('Typed multi-field entry exists; captured ordinary entry does not establish the raised period, prior-source, scope and conflict investigation.', 'BL-086 / BL-PPC-02 / PW-002')
    if name.startswith('E6-promote'):
        return ('Bulk 승진 targets 직위; its 직급 cell renders position 사원 while the card grade is 선임. The ideal per-person grade suggestions/counts/follow-position choice are absent.', 'BL-120 / BL-147')
    if name.startswith('E2-history'):
        return ('Real promotion history exists; the complete grade period/source, correction and withdrawal evidence fixture remains incomplete.', 'BL-086 / BL-PPC-02')
    return ('Catalog labels and grade actions resolve on the card/menu; complete field floor, dated grade evidence and shared IA/space parity remain incomplete.', 'BL-008 / BL-120 / PW-001–003')


def main():
    latest = {}
    for f in json.loads((DESIGN / 'manifest.json').read_text())['frames']:
        if not re.match(r'^frames/(ideal|structure|employee|attendance|roles)/', f['path']):
            continue
        key = vertical(f), f['name']
        if key not in latest or f['iteration'] > latest[key]['iteration']:
            latest[key] = f
    assert len(latest) == 969, 'Review changed manifest membership'
    targets = {f['id']: f for (v, _), f in latest.items()
               if v == 'people' and base_name(f['name']) in NAMES}
    assert len(targets) == 18, 'Review changed grade scope'
    baseline = subprocess.check_output(['git', 'show', f'{BASELINE}:docs/design/regression/parity-2026-10-12-copy.md'], text=True)
    assert re.search(r'\| \*\*Total\*\* \| \*\*0\*\*', baseline), 'Prior MEETS smoke set changed'
    previous = {}
    for line in Path('docs/design/regression/parity-2026-10-11/people.md').read_text().splitlines():
        if line.startswith('| `'):
            cols = [s.strip() for s in line.split('|')]
            previous[cols[1].strip('`')] = cols[3]
    assert all(previous[x] == 'PARTIAL' for x in targets)
    assert all(f'| {v} | 0 |' in baseline for v in ('org', 'entities', 'access'))
    for v in ('home-first-run', 'attendance', 'audit'):
        old = Path(f'docs/design/regression/parity-2026-10-10/{v}.md').read_text()
        assert not re.search(r'\| MEETS \|', old), 'Prior MEETS smoke set changed'
    records = {}
    for p in Path('node_modules/.cache/parity').glob('*.png.json'):
        obs = json.loads(p.read_text())
        png = (ROOT / obs['file']).read_bytes()
        validate(obs['frame'], png, targets)
        assert obs['file'] == f"people/{obs['frame'].replace('/', '__')}.png"
        assert obs['frame'] not in records, 'Duplicate capture'
        records[obs['frame']] = obs
    assert set(records) == set(targets), 'Missing grade captures'
    assert len(list(ROOT.glob('people/*.png'))) == len(records), 'Unreferenced frame image'
    sample = next(iter(records))
    png = (ROOT / records[sample]['file']).read_bytes()
    reject(lambda: validate('unknown/frame', png, targets))
    reject(lambda: validate(sample, png[:16] + struct.pack('>II', 1, 1) + png[24:], targets))
    supplementary = [json.loads(p.read_text()) for p in Path('node_modules/.cache/parity').glob('grade-*--*.json')]
    assert len(supplementary) == 12
    assert len(list(ROOT.glob('supplementary/*.png'))) == len(supplementary)
    for obs in supplementary:
        png = (ROOT / obs['file']).read_bytes()
        assert png[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', png[16:24]) == (1440, 1000)
    findings = [json.loads(p.read_text()) for p in Path('node_modules/.cache/parity').glob('*-axe.json')]
    assert len(findings) == 7
    assert not any(findings), 'Serious/critical axe findings require report revision'
    rows = []
    backlog = Path('docs/plans/ideal-backlog.md').read_text()
    for fid, f in sorted(targets.items()):
        obs = records[fid]
        deficit, owner = gap(f['name'])
        assert all(item in backlog for item in re.findall(r'BL-(?:PPC-)?\d+|PW-\d+', owner)), 'Unowned gap'
        boundary = ' · Chromium layout only; Firefox runtime unverified' if '--firefox' in f['name'] else ''
        rows.append(f"| [`{fid}`]({obs['file']}) | {f['state']} · {f['theme']} | BELOW | PARTIAL → BELOW (terminology only) | {deficit} | {owner} | `{obs['url']}` · {obs['observation']}{boundary} |")
    text = '# Grade-related people frames, October 12 evening\n\nSee [scope and proof](../parity-2026-10-12-grade.md). BELOW combines the prior PARTIAL/MISSING vocabulary; unchanged semantics are not regressions. Each PNG is fresh, but a small ancestor fixture does not prove the ideal scale or lifecycle.\n\n| Frame ID | State | Grade | Delta vs 05:00 | Concrete deficit | Owner | Actual scene / boundary |\n|---|---|---|---|---|---|---|\n' + '\n'.join(rows) + '\n'
    (ROOT / 'people.md').write_text(text)
    print(f'18 newest targets: 0 MEETS / 18 BELOW / 0 REGRESSED; 30 PNGs; 7 axe scenes × 2 themes; two negative controls rejected')


if __name__ == '__main__':
    main()
