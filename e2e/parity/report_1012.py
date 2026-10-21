"""Grade only Home/first-run and the statutory targets inherited from people."""
import collections
import json
import re
import struct
import sys
from pathlib import Path

from report import DESIGN, vertical
from report_1011 import rules_for

ROOT = Path('docs/design/regression/parity-2026-10-12')
BASE = Path('docs/design/regression/parity-2026-10-11')
CACHE = Path('node_modules/.cache/parity')


def selected(f):
    return vertical(f) == 'home-first-run' or bool(re.match(r'^E10-|^L3-attest', f['name']))


def validate_png(png, f):
    assert png[:8] == b'\x89PNG\r\n\x1a\n', 'PNG signature'
    assert struct.unpack('>II', png[16:24]) == (f['width'], f['height']), 'PNG dimensions'


def compile_report():
    latest = {}
    for f in json.loads((DESIGN / 'manifest.json').read_text())['frames']:
        if not re.match(r'^frames/(ideal|structure|employee|attendance|roles)/', f['path']) or not selected(f):
            continue
        key = vertical(f), f['name']
        if key not in latest or f['iteration'] > latest[key]['iteration']:
            latest[key] = f
    assert len(latest) == 92, 'Review changed target membership'
    targets = {f['id']: f for f in latest.values()}
    assert len(targets) == 92
    goldens = {g['id'] for g in json.loads((DESIGN / 'golden.json').read_text())}
    for f in targets.values():
        assert set(f['golden']) <= goldens, 'Unknown golden assertion'
    baseline = {}
    for v in ('home-first-run', 'people'):
        for line in (BASE / f'{v}.md').read_text().splitlines():
            if line.startswith('| `'):
                cols = [s.strip() for s in line.split('|')]
                baseline[cols[1].strip('`')] = cols[3]
    assert set(targets) <= set(baseline), 'Every target needs its October 11 grade'
    observations = {}
    fresh_since = float((CACHE / 'final-start.txt').read_text())
    for p in CACHE.glob('*.png.json'):
        x = json.loads(p.read_text())
        f = targets[x['frame']]
        png = ROOT / x['file']
        assert png.stat().st_mtime >= fresh_since, 'Stale browser evidence'
        validate_png(png.read_bytes(), f)
        observations[f['id']] = x
    assert observations, 'Fresh browser evidence required'
    screenshots = list(ROOT.glob('home-first-run/*.png')) + list(ROOT.glob('people/*.png'))
    assert len(screenshots) == len(observations), 'No stale or unreferenced manifest captures'
    backlog = Path('docs/plans/ideal-backlog.md').read_text()
    counts, deltas = {}, collections.Counter()
    for v in ('home-first-run', 'statutory'):
        rows, count = [], collections.Counter()
        for f in sorted(targets.values(), key=lambda f: f['id']):
            if (vertical(f) == 'home-first-run') != (v == 'home-first-run'):
                continue
            if v == 'home-first-run':
                _, code, gap, owner = next(r for r in rules_for(v) if re.search(r[0], f['name']))
                if re.match(r'^H3-|^P6-.*stale', f['name']):
                    gap = 'Real preview_stale409 and retained consent now exercised; complete before/current/proposed dependency diff and same-count grant/policy mutation remain unproved.'
                elif f['name'].startswith('H5-'):
                    gap = 'Four derived insurance duties now visible; HOLD stays explicit. Full ranked agenda, legal provenance/version expansion and source-specific clocks remain incomplete.'
                elif re.match(r'^H1-(master|setup)|^S1-home|^P6-(golive-preview|golive-migration)', f['name']):
                    gap = 'Fact-derived rail, equal entry paths, per-site launch census and exact terms exist; long repeated step rows, duplicated prerequisite actions, missing shared scope and compact focused act differ.'
                    owner = 'BL-013 / BL-014 / BL-015 / PW-001 / PW-002 / PW-003 · FR-1 + HOME'
                elif f['name'].startswith('P5-consent-text'):
                    gap = 'Go-live terms now expose and submit the exact version/hash; failed GET uses command-outcome-checking copy. First-contact terms fixture and support recovery remain unproved.'
                    owner = 'BL-015 / CX-HF-06 / CX-HF-09 / BL-076 · FR-1 + LEDGER + OPS'
            else:
                code = 'P'
                if f['name'].startswith('L3-'):
                    gap = 'Completion preview/receipt/undo and real stale409 work; preview treats receipt number and evidence as optional, no typed evidence alternative or source/article/rule-version expansion. Exact NHIS loss fixture unexercised.'
                    owner = 'BL-038 / BL-118 / BL-PPC-03 / CX-HF-10 · TRAIL + PPL-4'
                else:
                    gap = 'Per-site dated register, gap links, purpose-bound xlsx and browser print now exercised; retained exits, privacy/masking parity, exact framed census/routed export and complete scope/artifact provenance remain unproved or incomplete.'
                    owner = 'BL-149 / BL-PPC-04 / PW-001 · PPL-5 + ACCESS'
            grade = {'P': 'PARTIAL', 'M': 'MISSING', 'R': 'REGRESSED'}[code]
            old = baseline[f['id']]
            delta = 'unchanged' if old == grade else f'{old} → {grade}'
            deltas[delta] += 1
            count[grade] += 1
            for item in re.findall(r'BL-(?:PPC-)?\d+|CX-HF-\d+|PW-\d+', owner):
                assert item in backlog, f'Unowned finding: {item}'
            obs = observations.get(f['id'])
            evidence = f"[capture]({obs['file']}) · `{obs['url']}` · {obs['observation']}" if obs else 'October 11 assessment retained; exact fixture not freshly exercised; runtime status unknown'
            if '--firefox' in f['name']:
                evidence += ' · Chromium layout only; Firefox runtime unverified'
            rows.append(f"| `{f['id']}` | {f['state']} · {f['theme']} | {grade} | {delta} | {gap} | {owner} | {evidence} |")
        counts[v] = count
        text = f"# {v}: October 12 frame grades\n\nSee [scope and proof](../parity-2026-10-12.md). Newest logical frame versions remain the target. Exact fixtures without fresh evidence retain the October 11 design assessment; runtime remains unknown. Ancestor captures never establish the drawn lifecycle/scale state.\n\n| Frame ID | State | Grade | Delta vs October 11 | Concrete gaps | Backlog / owner | Evidence |\n|---|---|---|---|---|---|---|\n" + '\n'.join(rows) + '\n'
        assert len(text.splitlines()) < 300
        (ROOT / f'{v}.md').write_text(text)
    total = sum(counts.values(), collections.Counter())
    assert sum(total.values()) == 92
    print(dict(total), 'deltas', dict(deltas), 'manifest captures', len(observations))
    scenes = list(CACHE.glob('scene-*.json'))
    assert len(scenes) == 15, 'Every supplementary state needs fresh evidence'
    for p in scenes:
        name = json.loads(p.read_text())['name']
        for suffix in ('', '--dark'):
            png = ROOT / 'statutory' / f'{name}{suffix}.png'
            assert png.stat().st_mtime >= fresh_since, 'Stale supplementary evidence'
            validate_png(png.read_bytes(), {'width': 1440, 'height': 1000})
    assert len(list((ROOT / 'statutory').glob('*.png'))) == 2 * len(scenes)
    print('supplementary captures', 2 * len(scenes))


def negative_controls():
    header = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 1440, 1000)
    validate_png(header, {'width': 1440, 'height': 1000})
    for corrupt in (b'bad' + header[3:], header[:16] + struct.pack('>II', 1439, 1000)):
        try:
            validate_png(corrupt, {'width': 1440, 'height': 1000})
        except AssertionError:
            continue
        raise AssertionError('Negative control did not fail')
    assert not selected({'path': 'frames/attendance/old.png', 'name': 'A2-schedule'})
    print('Negative controls reject bad signature, wrong dimensions and out-of-scope target')


if __name__ == '__main__':
    negative_controls()
    if '--self-check' not in sys.argv:
        compile_report()
