#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
[[ "$#" == 2 && -f "$2" ]] || { echo "usage: bootstrap-db.sh CONTAINER ENV_FILE" >&2; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
# Share the existing pre-/post-migration enforcement with the executed census tests.
docker cp "$2" "$1:/topology.env"
docker exec "$1" chmod 600 /topology.env
docker cp "$root/scripts/ci/postgres-reconcile-topology.sh" "$1:/topology.sh"
docker exec --env-file "$2" "$1" bash /topology.sh
probe="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).topologyProbeDatabase)' "$root/scripts/ci/config.json")"
bash "$root/backend/ci/gates/writer-ownership/canonical-enforce.sh" "$root" "$1" "$probe"
