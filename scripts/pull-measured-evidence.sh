#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
reader=${1:?usage: pull-measured-evidence.sh READER_DIR [REPO]}
repo=${2:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export CONSOLE_NEXT=${CONSOLE_NEXT:-$(git rev-parse --show-toplevel)}
gh run list --repo "$repo" --workflow ci.yml --branch dev --event push --status completed --limit 1 \
  --json databaseId,headSha,headBranch,event > "$scratch/run.json"
python3 - "$scratch" "$reader" "$repo" <<'PY'
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('producer', 'scripts/d7-evidence.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
sys.path.insert(0, sys.argv[2])
import evidence

root, repo = Path(sys.argv[1]), sys.argv[3]
runs = json.loads((root / 'run.json').read_text())
if not runs: sys.exit('no completed dev CI run')
run = runs[0]
if run['event'] != 'push' or run['headBranch'] != 'dev': sys.exit('only a dev push run may be ingested')
pages = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/actions/runs/{run["databaseId"]}/artifacts', '--paginate', '--slurp'], text=True))
names = {a['name'] for page in pages for a in page['artifacts'] if not a.get('expired')}
# Keep already-published dev evidence usable while the standalone states artifact rolls out.
states = 'states-evidence' if 'states-evidence' in names else 'd8-evidence'
if states not in names: sys.exit('latest dev run has no states artifact')
for artifact in (states, 'd7-evidence'):
    subprocess.run(['gh', 'run', 'download', str(run['databaseId']), '--repo', repo, '--name', artifact, '--dir', str(root / artifact)], check=True)
for name in ('states', 'e2e', 'nextest'):
    source = root / (states if name == 'states' else 'd7-evidence') / (name + '.json')
    data = json.loads(source.read_text())
    if data['commit'] != run['headSha']: sys.exit('artifact commit differs from CI dev commit')
    producer.fresh(data['run_at'])
    evidence.validate(data, name)
    source.rename(root / source.name)
print(f'Validated dev evidence: {run["headSha"]} (run {run["databaseId"]})')
PY
for source in states e2e nextest; do
  python3 "$reader/evidence.py" ingest "$scratch/$source.json"
done
