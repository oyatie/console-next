#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
run=${1:?usage: pull-d7-evidence.sh RUN_ID READER_DIR [REPO]}
reader=${2:?usage: pull-d7-evidence.sh RUN_ID READER_DIR [REPO]}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
repo=${3:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}
export CONSOLE_NEXT=${CONSOLE_NEXT:-$(git rev-parse --show-toplevel)}
gh run view "$run" --repo "$repo" --json headSha,headBranch,event > "$scratch/run.json"
gh run download "$run" --repo "$repo" --name d7-evidence --dir "$scratch"
python3 - "$scratch" "$reader" <<'PY'
import json
from pathlib import Path
import sys
import importlib.util
spec = importlib.util.spec_from_file_location('producer', 'scripts/d7-evidence.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
root = Path(sys.argv[1])
sys.path.insert(0, str(Path(sys.argv[2])))
import evidence
run = json.loads((root / 'run.json').read_text())
if run['event'] != 'push' or run['headBranch'] != 'dev':
    sys.exit('D7: only a dev push run may be ingested')
for name in ('e2e', 'nextest'):
    data = json.loads((root / (name + '.json')).read_text())
    if data['commit'] != run['headSha']: sys.exit('D7: artifact commit differs from CI dev commit')
    producer.fresh(data['run_at'])
    evidence.validate(data, name)
PY
python3 "$reader/evidence.py" ingest "$scratch/e2e.json"
python3 "$reader/evidence.py" ingest "$scratch/nextest.json"
