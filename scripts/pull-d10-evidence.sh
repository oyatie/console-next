#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
run=${1:?usage: pull-d10-evidence.sh RUN_ID READER_DIR [REPO]}
reader=${2:?usage: pull-d10-evidence.sh RUN_ID READER_DIR [REPO]}
repo=${3:-${GITHUB_REPOSITORY:?provide REPO or GITHUB_REPOSITORY}}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export CONSOLE_NEXT=${CONSOLE_NEXT:-$(git rev-parse --show-toplevel)}
gh run view "$run" --repo "$repo" --json headSha,headBranch,event > "$scratch/run.json"
gh run download "$run" --repo "$repo" --name d10-evidence --dir "$scratch"
python3 - "$scratch" "$reader" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('producer', 'scripts/d10-evidence.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
sys.path.insert(0, sys.argv[2])
import evidence
root = Path(sys.argv[1])
run = json.loads((root / 'run.json').read_text())
if run['event'] != 'push' or run['headBranch'] != 'dev': sys.exit('D10: only a dev push run may be ingested')
data = json.loads((root / 'authorization.json').read_text())
if data['commit'] != run['headSha']: sys.exit('D10: artifact commit differs from CI dev commit')
producer.d7.fresh(data['run_at'])
evidence.validate(data, 'authorization')
PY
python3 "$reader/evidence.py" ingest "$scratch/authorization.json"
