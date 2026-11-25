#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
reader=${1:?usage: pull-measured-evidence.sh READER_DIR [REPO]}
repo=${2:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export CONSOLE_NEXT=${CONSOLE_NEXT:-$(git rev-parse --show-toplevel)}
# The listing's status filter can omit a finished run.
gh run list --repo "$repo" --workflow ci.yml --branch dev --event push \
  --json databaseId,headSha,headBranch,event,status > "$scratch/run.json"
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
run = next((run for run in runs if run['status'] == 'completed'), None)
if run is None: sys.exit('no completed dev CI run')
if run['event'] != 'push' or run['headBranch'] != 'dev': sys.exit('only a dev push run may be ingested')
job_pages = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/actions/runs/{run["databaseId"]}/jobs', '--paginate', '--slurp'], text=True))
jobs = {job['name']: job.get('conclusion') for page in job_pages for job in page['jobs']}
conclusion = jobs.get('Collect release test evidence')
if conclusion not in ('success', 'skipped'):
    sys.exit(f'producer release-evidence concluded {conclusion or "unknown"}')
pages = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/actions/runs/{run["databaseId"]}/artifacts', '--paginate', '--slurp'], text=True))
names = {a['name'] for page in pages for a in page['artifacts'] if not a.get('expired')}
# Accept older combined artifacts during the independent producers' rollout.
artifacts = {}
for name in ('e2e', 'nextest'):
    artifact = next((candidate for candidate in (name + '-evidence', 'd7-evidence') if candidate in names), None)
    if artifact: artifacts[name] = artifact
    else: print(f'Unavailable measured source in latest dev run: {name} (producer release-evidence: {conclusion})')
if not artifacts: sys.exit('latest dev run has no measured artifacts')
for artifact in dict.fromkeys(artifacts.values()):
    subprocess.run(['gh', 'run', 'download', str(run['databaseId']), '--repo', repo, '--name', artifact, '--dir', str(root / artifact)], check=True)
for name, artifact in artifacts.items():
    source = root / artifact / (name + '.json')
    data = json.loads(source.read_text())
    if data['commit'] != run['headSha']: sys.exit('artifact commit differs from CI dev commit')
    producer.fresh(data['run_at'])
    evidence.validate(data, name)
    source.rename(root / source.name)
print(f'Validated dev evidence: {run["headSha"]} (run {run["databaseId"]})')
PY
for source in e2e nextest; do
  if [[ -f "$scratch/$source.json" ]]; then
    python3 "$reader/evidence.py" ingest "$scratch/$source.json"
  fi
done
