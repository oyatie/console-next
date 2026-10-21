"""Compile the independent walk's observations and source findings into frame tables."""
import collections
import json
import os
import re
import struct
from pathlib import Path

DESIGN = Path(os.environ.get('PARITY_DESIGN', '../console-design'))
ROOT = Path('docs/design/regression/parity-2026-10-10')
GRADES = ('MEETS', 'PARTIAL', 'MISSING', 'REGRESSED')


def vertical(f):
    p, n = f['path'], f['name']
    if p.startswith('frames/ideal/'):
        return p.split('/')[2]
    if p.startswith('frames/structure/'):
        return 'home-first-run' if re.match(r'^(P|S1-)', n) else 'entities' if re.match(r'^S[345]-|^S2-registry', n) else 'org'
    if p.startswith('frames/employee/'):
        return 'home-first-run' if re.match(r'^(H1-|P7-)', n) else 'people'
    if p.startswith('frames/roles/'):
        return 'audit' if re.match(r'^M(10|14|15)-', n) else 'access'
    return 'attendance'


# A missing feature is established from the mounted routes and connected UI, not from a failed test selector.
# P = a reachable ancestor/partial workflow; M = the specified capability/state is unserved; R = worse than the older drawn golden.
RULES = {
    'home-first-run': [
        (r'^H2-|^H1-resume', 'M', 'No owner-private draft list with expiry/dependency repair on Home.', 'BL-202 / CX-HF-02 · DRAFTS'),
        (r'^H10-', 'M', 'No privacy/internal-management-plan setup facts or review-cadence editor.', 'BL-102 / CX-HF-10 · FR-2'),
        (r'^H12-', 'M', 'No executed native notification, session/update or phone-handoff surface.', 'BL-203 / CX-HF-12 · SHELL'),
        (r'^H3-|^P6-.*stale', 'P', 'Preview/blockers exist; full source/grant/policy fingerprint conflict is not the rendered target.', 'BL-014 / CX-HF-03 · FR-1'),
        (r'^H4-|^P7-', 'P', 'Launch returns to Home; no immutable launch-snapshot/output receipt or first-day obligation ledger.', 'BL-101 / CX-HF-04 · FR-2'),
        (r'^H5-', 'P', 'Basic deadline sections exist; agenda, per-insurer legal provenance/HOLD and audited handover are incomplete.', 'BL-039 / BL-115 / CX-HF-05 · HOME-2 + TRAIL'),
        (r'^H6-|^H11-|^H1-inbox-live-down|^S1-loading', 'P', 'Independent failure/loading notices exist; no per-source last-good timestamp, unknown count and complete reserved geometry.', 'CX-HF-06 · HOME'),
        (r'^H7-|^H1-inbox-scale', 'P', 'Home composes capped source lists (LIST=8), not a stable total-order/keyset/snapshot-bound queue.', 'BL-019 / CX-HF-07 · HOME'),
        (r'^H8-', 'P', 'Partial403 notice exists; actual two-tab revocation/cache/selection/notification purging is not proved here.', 'CX-HF-08 · HOME'),
        (r'^H9-', 'P', 'Request outcome route/refusal exists; Home original-request recovery and full raised evidence states remain incomplete.', 'BL-010 / CX-HF-09 · LEDGER'),
        (r'^P[123]-', 'P', 'Vendor bootstrap exists on /platform; separate ops-origin/two-operator realm target is incomplete.', 'BL-071 · OPS'),
        (r'^P[45]-', 'P', 'Code/passkey sign-in exists; full identifier-first and support-reference recovery target is incomplete.', 'BL-006 / BL-076 · IF-AUTH-ID + OPS'),
        (r'.*', 'P', 'Setup/queue exists; equal-weight paste/import, numeric summary/scope and the ideal rail labels are incomplete.', 'BL-013 / BL-022 / PW-001 · FR-1 + HOME'),
    ],
    'entities': [
        (r'^E1-', 'P', 'Record has registration links and honest held headcount, not a dated statutory-unit/applicability matrix.', 'ENT-C01 / BL-096 · ENT-5'),
        (r'^E2-', 'P', 'Certificate/document/revision ancestors exist; source-region provenance, dated originals and evidence workflow are incomplete.', 'ENT-C02 / BL-124 · ENT-3 + ENT-2'),
        (r'^E3-', 'P', 'Closure dialog has blockers; no revision-bound per-person/child/grant executable plan and compensation/result lifecycle.', 'ENT-C03 / BL-121 / BL-214 · ENT-4'),
        (r'^E4-', 'M', 'No durable entity bulk job/row-outcome lifecycle with fixed server membership and eligible-only retry.', 'ENT-C04 / BL-174 · ENT-2'),
        (r'^E5-', 'M', 'No designed desktop/mobile handoff, memory-only offline or revocation continuity screen.', 'ENT-C05 / BL-203 · ENT-1 + SHELL'),
        (r'^S4-', 'P', 'Registration wizard exists; certificate highlight/error-summary and individual/organisation fixture fidelity are incomplete.', 'BL-001 / BL-124 · ENT-2'),
        (r'^S3-.*(detail|docs|revise|correct)', 'P', 'Record/editor exists; extra standing text, raw history fields/enums and complete evidence-linked dated facts differ.', 'BL-077 / BL-084 / PW-002 · ENT-1'),
        (r'^S[35]-.*(close|transfer)', 'P', 'Basic closure/move ancestor exists; consent-backed transfer and complete per-person closure plan are incomplete.', 'BL-121 / BL-122 / BL-214 · ENT-2 + ENT-4'),
        (r'.*', 'P', 'Entity/workplace ancestor exists; statutory source completeness, exact framed lifecycle fixture and ideal shell remain incomplete.', 'BL-001 / BL-077 / PW-001 · ENT-1'),
    ],
    'org': [
        (r'^S14-(empty|loading|preflight)', 'P', 'Chart/one-act draft exists; no atomic unit+every-person destination editor/dependency graph.', 'CEIL-ORG-W-01 · CX-ORG-SET'),
        (r'^S14-temporal', 'P', 'As-of/known-at/compare controls exist; shared snapshot across people/counts/export and all future dependencies is incomplete.', 'CEIL-ORG-W-02 · CX-ORG-ASOF'),
        (r'^S14-access', 'M', 'No net effective access source/destination widening/lockout comparison surface.', 'CEIL-ORG-W-03 · CX-ORG-ACCESS'),
        (r'^S14-transfer', 'M', 'No integrated all-person cross-법인 consent/independent continuity destination plan.', 'CEIL-ORG-W-01 · CX-ORG-SET'),
        (r'^S14-(law|unknown)', 'M', 'No owned evidence obligations/HOLD legal-clock table and mandatory completion gate.', 'CEIL-ORG-W-04 / CEIL-ORG-W-05 · CX-ORG-TRAIL'),
        (r'^S14-conflict', 'P', 'Basic stale refusal exists; no three-value per-act dependency fingerprint conflict/re-preview scene.', 'CEIL-ORG-W-06 · CX-ORG-CONFLICT'),
        (r'^S14-(success|execution-error)', 'P', 'Single-act receipt exists; no complete durable scheduled-set/failure/repair outcome lifecycle.', 'CEIL-ORG-W-07 · CX-ORG-RESULT'),
        (r'^S14-recovery', 'M', 'No current-dependency inverse plan with explicit moved-people/expired-rights/paid-result exclusions.', 'CEIL-ORG-W-08 · CX-ORG-RECOVERY'),
        (r'^S14-(export|mobile)', 'P', 'Browser export ancestor exists; readable purpose/snapshot-bound evidence package and native continuation are incomplete.', 'CEIL-ORG-W-09 · CX-ORG-CRAFT'),
        (r'^S7-import-', 'P', 'UI import ancestor exists; durable plan/run/SSE/original-result and dependency-aware undo target is incomplete.', 'BL-174 / BL-010 · ENT-2 + LEDGER'),
        (r'^S9-', 'P', 'As-of/history/compare ancestors exist; complete dated shared snapshot, saved view and change-set evidence differ.', 'BL-023 / BL-025 / BL-091 · ASOF + ORG-3'),
        (r'^S6-.*(capacity|merge)|^S2-chart-capacity', 'P', 'Department ancestor exists; dated capacity, merge survivor choices and consequence counts are incomplete.', 'BL-062 / BL-094 · ORG-2'),
        (r'.*', 'P', 'Chart/outline/list/action ancestors exist; framed scale/lifecycle fixture and full canvas use/standing-text rules differ.', 'BL-002 / PW-002 / PW-003 · ORG-1 + CX-ui-purpose'),
    ],
    'people': [
        (r'^E12-(loading|error)$', 'R', 'Zero-facet first-use branch hides roster loading/error: delayed or GET500 list renders an empty roster without retry, worse than the older E12 golden.', 'PW-004 · PPL-1'),
        (r'^M-', 'M', 'No native phone reading/offline/handoff lifecycle surface.', 'BL-PPC-06 / BL-213 · PPL-UI + NATIVE'),
        (r'^C-', 'P', 'Correction ancestor exists; interval split, preserved future facts and closed-period dependency/forward-delta scene are incomplete.', 'BL-PPC-02 / BL-086 · PPL-CORRECT'),
        (r'^R-', 'P', 'Roster/card ancestors exist; fixed employment membership, scoped evidence and all-person investigation lifecycle are incomplete.', 'BL-PPC-01 / BL-PPC-04 · PPL-BULK + ACCESS'),
        (r'^E3-register(?:$|-initial|-term|-dup|-error)', 'R', 'Older E3 golden requires name+hire only and optional placement; live form requires 7 facts including phone/title/pay and refuses unplaced.', 'BL-026 · PPL-1'),
        (r'^E2-docs', 'M', 'Documents tab renders an unserved notice; no document list/upload/evidence/read-log lifecycle.', 'BL-190 · PPL-6'),
        (r'^E2-cert-(issued|register|exited)', 'M', 'Certificate preview exists but issuance/number/seal/register are disabled; no issued/registered state.', 'BL-191 · PPL-6'),
        (r'^E2-cert', 'P', 'Option-first certificate preview exists; issuance/number/seal/register cannot execute.', 'BL-191 · PPL-6'),
        (r'^E1-.*(views|selectall|scope|scoped)', 'P', 'Roster exists; saved view/missing-register facets and server all-matching selection beyond500 are incomplete.', 'BL-029 / BL-030 · PPL-1'),
        (r'^E1-', 'P', 'Roster/search/peek ancestors exist; framed identity/scale fixture and full scope/selection evidence are incomplete.', 'BL-027 / BL-028 / BL-PPC-01 · PPL-1'),
        (r'^E2-(asof|history|ledger|inline|reveal)', 'P', 'Card/action and section history exists; past reads, field corrections/reveal/read ledger are not complete.', 'BL-056 / BL-057 / BL-148 · PPL-2'),
        (r'^E[456]-', 'P', 'HR action/grid ancestor exists; complete entitlement/consent/row conflict and dependency-aware correction states differ.', 'BL-086 / BL-117 / BL-147 · PPL-3 + PPL-4 + PPL-5'),
        (r'^E7-', 'P', 'Import ancestor exists; durable replay/atomic per-row evidence/acknowledged signoff and dependency undo are incomplete.', 'BL-PPC-05 / BL-187 / BL-188 · PPL-6 + LEDGER'),
        (r'^(L|E8-|E9-)', 'P', 'Exit/lifecycle ancestors exist; full owned evidence, per-insurer clocks and mandatory completion coverage are incomplete.', 'BL-038 / BL-118 / BL-PPC-03 · TRAIL + PPL-4'),
        (r'^E11-', 'P', 'Account/grant ancestor exists; per-record effective/read-source explanation and access/read log are incomplete.', 'BL-132 / BL-180 / BL-193 · ACC-3 + ACC-5'),
        (r'^R1-|^E10-', 'P', 'Register/print ancestor exists; permission-bound dated per-site artifact and purpose/retention evidence are incomplete.', 'BL-149 / BL-PPC-04 · PPL-5 + ACCESS'),
        (r'.*', 'P', 'Personnel screen ancestor exists; exact state/fixture, all history/evidence and idle-control/standing-text targets remain incomplete.', 'BL-008 / BL-032 / PW-002 · PPL-1'),
    ],
    'attendance': [
        (r'^A2-|^A12-(first-run|loading|error|keys|denied|partial)', 'P', 'Schedule calendar/types/crews/holiday ancestors exist; complete canonical state/permission/keyboard fixture and shell differ.', 'BL-018 / BL-035 / PW-001 · IF-ATT-S1 + ATT-1'),
        (r'^A14-', 'M', 'No person-day calculation/provenance/legal-resolution screen or its six lifecycle states.', 'CA-ATT-01 · ATT-4'),
        (r'^A15-', 'M', 'No authoritative leave lot/entitlement simulator and §61 evidence lifecycle screen.', 'CA-ATT-02 / BL-128 · ATT-5'),
        (r'^A16-', 'M', 'No versioned close, receiver acknowledgement and scoped retro handoff lifecycle.', 'CA-ATT-03 / BL-069 · ATT-3'),
        (r'^A17-', 'M', 'No person-day exception job/row-ledger/held-refresh lifecycle screen.', 'CA-ATT-04 · ATT-5'),
        (r'^A18-|^A13-', 'M', 'No executed native/ESS detail, offline or decision lifecycle screen.', 'CA-ATT-05D / CA-ATT-05M / BL-231 · SHELL + LATER-ESS'),
        (r'^A[15]-', 'M', 'No today/absence board or authoritative leave use/balance/promotion screen.', 'BL-018 / BL-034 / BL-128 · IF-ATT-S2 + ATT-1 + ATT-4'),
        (r'^A[34]-', 'M', 'No recorded/recognised attendance or overtime approval/52-hour screen.', 'BL-018 / BL-130 · IF-ATT-S2 + IF-ATT-S3'),
        (r'^A[6789]-|^A1[012]-', 'M', 'Only 근무 일정 is mounted; designed close/evidence/exception/import/rule administration state is unserved.', 'BL-018 / BL-067 / BL-070 / BL-108 · ATT-2 + ATT-3'),
    ],
    'access': [
        (r'^C1-|^C8-|^C9-', 'M', 'No decision-source/time projection or complete forward/reverse effective-source explanation surface.', 'CE-AC-01 / BL-180 / BL-193 · ACC-5 + ACC-6'),
        (r'^C2-|^C10-|^C12-', 'P', 'Grant preview/bulk ancestor exists; net-retained rights, whole dependency fingerprint and bounded same-key recovery are incomplete.', 'CE-AC-02 / BL-196 · ACC-6'),
        (r'^C3-', 'P', 'Cross-법인 basis ancestor exists; evidence/settings revision and interval/source review are incomplete.', 'CE-AC-03 / BL-047 · ACC-1'),
        (r'^C4-', 'P', 'Role CRUD exists; no private draft/simulate/versioned governed activation/revert lifecycle.', 'CE-AC-04 / BL-194 · ACC-6'),
        (r'^C5-', 'P', 'Grant dates/statuses exist; suspension/exit/event dependency ledger, retained-history and fresh regrant coverage are incomplete.', 'CE-AC-05 / BL-105 · ACC-2 + ACC-4'),
        (r'^C6-', 'M', 'No complete evidence-bound review/signoff/unresolved-action closure screen.', 'CE-AC-06 / BL-175 · AUD-2'),
        (r'^C7-', 'M', 'No purpose-bound emergency-session/holder-handover screen; /access/ops is unserved.', 'CE-AC-07 / BL-074 · OPS'),
        (r'^C1[345]-', 'M', 'No mobile detail/offline/receipt continuation surface.', 'CE-AC-08 / BL-203 · ACC-3 + SHELL'),
        (r'^C11-', 'P', 'No-preset entry exists; full simulator/bulk/decision first-use target and ideal shell differ.', 'CE-AC-01 / PW-001 · ACC-5'),
        (r'^M(8|9|11|12|13|16)-|^M17-role-sod', 'M', 'No mounted review/simulator/tenant policy/reason-code or SoD administration screen.', 'BL-175 / BL-179 / BL-181 / BL-198 / BL-223 · AUD-2 + ACC-5 + ACC-6'),
        (r'.*', 'P', 'Role/grant CRUD/readiness ancestor exists; complete impact/version/basis/history and exact framed fixtures remain incomplete.', 'BL-004 / BL-046 / CE-AC-02 · ACC-1 + ACC-6'),
    ],
    'audit': [
        (r'^M10-changes|^H1-investigation-success', 'P', 'Entity history exists, with outcome/ops badge; raw fields/enums persist and no bounded tenant investigation filters/causal evidence surface.', 'BL-084 / CEIL-AUD-02 / CEIL-AUD-03 · ENT-1 + AUD-1'),
        (r'^H2-', 'M', 'No evidence range/independent checkpoint/export package lifecycle screen.', 'CEIL-AUD-01 / CEIL-AUD-05 · AUD-3'),
        (r'^H3-|^M14-', 'M', 'No complete access-log review/operator-evidence/immutable signoff lifecycle screen.', 'CEIL-AUD-04 / CEIL-AUD-06 / BL-175 · AUD-2 + OPS'),
        (r'^H6-|^M15-', 'M', 'No retention/purpose/hold preview, approved erasure job or certificate lifecycle screen.', 'CEIL-AUD-07 / BL-176 · AUD-3'),
        (r'.*', 'M', 'Tenant /audit is unserved; no investigation/search/verify/access-log state. A record history tab is not this screen.', 'BL-150 / CEIL-AUD-03 · AUD-1'),
    ],
}


def compile_report():
    latest = {}
    for f in json.loads((DESIGN / 'manifest.json').read_text())['frames']:
        if not re.match(r'^frames/(ideal|structure|employee|attendance|roles)/', f['path']):
            continue
        k = vertical(f), f['name']
        if k not in latest or f['iteration'] > latest[k]['iteration']:
            latest[k] = f
    assert len(latest) == 969, 'Review changed manifest membership before updating this acceptance count'
    by_id = {f['id']: f for f in latest.values()}
    assert len(by_id) == len(latest), 'Every logical target must retain its unique manifest ID'
    backlog = Path('docs/plans/ideal-backlog.md').read_text()
    for rules in RULES.values():
        for rule in rules:
            for item in re.findall(r'(?:BL-[A-Z]*\d*[A-Z]*-?\d+|CX-HF-\d+|CEIL-[A-Z]+-\d+|CEIL-ORG-W-\d+|ENT-C\d+|CE-AC-\d+|CA-ATT-\d+[DM]?|PW-\d+)', rule[3]):
                assert item in backlog, f'Unowned finding: {item}'
    observations = {}
    for p in Path('node_modules/.cache/parity').glob('*.png.json'):
        x = json.loads(p.read_text())
        f = by_id[x['frame']]
        png = (ROOT / x['file']).read_bytes()
        assert png[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', png[16:24]) == (f['width'], f['height']), x['file']
        assert x['file'] == f"{vertical(f)}/{f['id'].replace('/', '__')}.png"
        observations[x['frame']] = x
    assert len(list(ROOT.glob('*/*.png'))) == len(observations), 'No stale or unreferenced captures'
    counts = collections.defaultdict(collections.Counter)
    for v in RULES:
        rows = []
        for (fv, _), f in sorted(latest.items()):
            if fv != v:
                continue
            match = next(r for r in RULES[v] if re.search(r[0], f['name']))
            grade = {'P': 'PARTIAL', 'M': 'MISSING', 'R': 'REGRESSED'}[match[1]]
            counts[v][grade] += 1
            obs = observations.get(f['id'])
            evidence = f"[capture]({obs['file']}) · `{obs['url']}` · {obs['observation']}" if obs else 'source/related capture; exact fixture not walked'
            assert not obs or (ROOT / obs['file']).exists()
            variant = ' Chromium evidence; Firefox runtime unverified.' if '--firefox' in f['name'] else ''
            rows.append(f"| `{f['id']}` | {f['state']} · {f['theme']} | {grade} | {match[2]}{variant} | {match[3]} | {evidence} |")
        text = f"# {v}: newest frame grades\n\nSee [method, common gaps and proof](../parity-2026-10-10.md). Each row retains its complete manifest ID; missing screenshots mean the exact fixture was not walked. Ancestor captures do not claim the designed state is implemented. Common shell/standing-text gaps PW-001–003 apply to every reachable ancestor.\n\n| Frame ID | State | Grade | Concrete gaps | Backlog / owner | Evidence |\n|---|---|---|---|---|---|\n" + '\n'.join(rows) + '\n'
        assert len(text.splitlines()) < 300
        (ROOT / f'{v}.md').write_text(text)
    totals = sum(counts.values(), collections.Counter())
    assert sum(totals.values()) == len(latest)
    summary = '\n'.join(f"| [{v}](parity-2026-10-10/{v}.md) | " + ' | '.join(str(counts[v][g]) for g in GRADES) + f" | {sum(counts[v].values())} |" for v in RULES)
    summary += '\n| **Total** | ' + ' | '.join(str(totals[g]) for g in GRADES) + ' | 969 |'
    Path('node_modules/.cache/parity/counts.json').write_text(json.dumps(dict(totals)))
    Path('node_modules/.cache/parity/summary.md').write_text(summary)
    print(dict(totals), 'captures', len(observations))


if __name__ == '__main__':
    compile_report()
