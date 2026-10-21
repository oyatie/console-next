"""Compare the four released verticals with the committed October 10 walk."""
import collections
import json
import re
import struct
from pathlib import Path

from report import DESIGN, GRADES, RULES, vertical

ROOT = Path('docs/design/regression/parity-2026-10-11')
BASE = Path('docs/design/regression/parity-2026-10-10')
VERTICALS = ('home-first-run', 'org', 'people', 'access')


def rules_for(v):
    rules = list(RULES[v])
    if v == 'people':
        rules[0] = (rules[0][0], 'P', 'Loading and actionable error now precede first-use empty with zero facets; full framed geometry, last-good and scale fixtures remain unproved.', 'PW-004 / PW-003 · PPL-1 + CX-ui-purpose')
        rules[4] = (rules[4][0], 'P', 'Name+hire date and unplaced registration now work; RRN entry still defers to the card, consequence/number preview and compact additional facts differ. Exact duplicate/contract/IME and four-click fixtures are not all verified.', 'BL-026 / PW-002 · PPL-1')
    if v == 'home-first-run':
        rules = [(pattern, grade, gap, owner) if pattern != '.*' else
                 (pattern, grade, 'Fact-derived census, three entry paths and exact terms now exist; shared scope/rail, owned draft resumption and the complete framed queue remain incomplete.', 'BL-013 / BL-022 / CX-HF-02 / PW-001 · FR-1 + HOME')
                 for pattern, grade, gap, owner in rules]
        rules = [(pattern, grade, gap, owner) if pattern != '^P[45]-' else
                 (pattern, grade, 'Identifier-first, usernameless fallback and generic no-passkey recovery now work; separate ops-origin/support recovery and real security-key/phone fixtures remain unproved.', 'BL-006 / BL-076 / PW-001 · IF-AUTH-ID + OPS')
                 for pattern, grade, gap, owner in rules]
        rules = [(pattern, grade, gap, owner) if pattern != '^H3-|^P6-.*stale' else
                 (pattern, grade, 'Launch shows structured counts, blockers and exact terms; full three-value changed-dependency recovery and raised conflict fixture remain incomplete.', 'BL-014 / CX-HF-03 · FR-1')
                 for pattern, grade, gap, owner in rules]
    if v == 'org':
        rules[-1] = ('.*', 'P', 'Repeated child addition is reachable; tall date/known-at/compare chrome still reduces the canvas. Exact scale/lifecycle fixtures, shared scope/count semantics and ideal rail remain incomplete.', 'BL-002 / CEIL-ORG-W-02 / PW-001 / PW-003 · ORG-1 + CX-ORG-ASOF')
    return rules


def compile_report():
    latest = {}
    for f in json.loads((DESIGN / 'manifest.json').read_text())['frames']:
        if not re.match(r'^frames/(ideal|structure|employee|attendance|roles)/', f['path']):
            continue
        v = vertical(f)
        if v not in VERTICALS:
            continue
        key = v, f['name']
        if key not in latest or f['iteration'] > latest[key]['iteration']:
            latest[key] = f
    assert len(latest) == 575, 'Review changed membership before grading'
    by_id = {f['id']: f for f in latest.values()}
    assert len(by_id) == len(latest)
    observations = {}
    for p in Path('node_modules/.cache/parity').glob('*.png.json'):
        x = json.loads(p.read_text())
        f = by_id[x['frame']]
        png = (ROOT / x['file']).read_bytes()
        assert png[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', png[16:24]) == (f['width'], f['height']), x['file']
        assert x['file'] == f"{vertical(f)}/{f['id'].replace('/', '__')}.png"
        observations[x['frame']] = x
    assert observations, 'Browser observations are required'
    assert len(list(ROOT.glob('*/*.png'))) == len(observations), 'No stale/unreferenced captures'
    counts, deltas = {}, collections.Counter()
    for v in VERTICALS:
        before = {}
        for line in (BASE / f'{v}.md').read_text().splitlines():
            if line.startswith('| `'):
                columns = [s.strip() for s in line.split('|')]
                before[columns[1].strip('`')] = columns[3]
        rows, count = [], collections.Counter()
        for (fv, _), f in sorted(latest.items()):
            if fv != v:
                continue
            pattern, code, gap, owner = next(r for r in rules_for(v) if re.search(r[0], f['name']))
            grade = {'P': 'PARTIAL', 'M': 'MISSING', 'R': 'REGRESSED'}[code]
            old = before.pop(f['id'])
            delta = 'unchanged'
            if old != grade:
                delta = f'{old} → {grade}'
                deltas[delta] += 1
            count[grade] += 1
            obs = observations.get(f['id'])
            evidence = f"[capture]({obs['file']}) · `{obs['url']}` · {obs['observation']}" if obs else 'Inherited assessment; exact fixture not re-exercised in this scoped walk'
            if '--firefox' in f['name']:
                evidence += ' · Chromium layout only; Firefox runtime unverified'
            rows.append(f"| `{f['id']}` | {f['state']} · {f['theme']} | {grade} | {delta} | {gap} | {owner} | {evidence} |")
        assert not before, 'Every baseline frame must be accounted for'
        counts[v] = count
        text = f"# {v}: October 11 frame grades\n\nSee [scope, deltas and proof](../parity-2026-10-11.md). Full manifest IDs preserve newest-version selection. An ancestor screenshot is not proof of its designed scale/lifecycle state. Uncaptured rows carry the October 10 assessment, with updated source findings; they are not fresh runtime coverage. Shared IA gaps PW-001–003 still prevent whole-frame MEETS.\n\n| Frame ID | State | Grade | Delta vs October 10 | Concrete gaps | Backlog / owner | Evidence |\n|---|---|---|---|---|---|---|\n" + '\n'.join(rows) + '\n'
        assert len(text.splitlines()) < 300
        (ROOT / f'{v}.md').write_text(text)
    total = sum(counts.values(), collections.Counter())
    assert sum(total.values()) == 575
    backlog = Path('docs/plans/ideal-backlog.md').read_text()
    for v in VERTICALS:
        for _, _, _, owner in rules_for(v):
            for item in re.findall(r'(?:BL-[A-Z]*\d*[A-Z]*-?\d+|CX-HF-\d+|CEIL-ORG-W-\d+|CE-AC-\d+|PW-\d+)', owner):
                assert item in backlog, f'Unowned finding: {item}'
    summary = '\n'.join(f"| [{v}](parity-2026-10-11/{v}.md) | " + ' | '.join(str(counts[v][g]) for g in GRADES) + f" | {sum(counts[v].values())} |" for v in VERTICALS)
    summary += '\n| **Total** | ' + ' | '.join(str(total[g]) for g in GRADES) + ' | 575 |'
    Path('node_modules/.cache/parity/summary-1011.md').write_text(summary + '\n')
    print(dict(total), 'deltas', dict(deltas), 'captures', len(observations))


if __name__ == '__main__':
    compile_report()
