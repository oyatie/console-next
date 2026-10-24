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
contract="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).apalisContractDatabase)' "$root/scripts/ci/config.json")"
[[ "$contract" =~ ^[a-z_]+_contract$ ]] || { echo "invalid isolated Apalis database" >&2; exit 2; }
docker exec --env-file "$2" "$1" bash -c '
  export PGPASSWORD="$POSTGRES_ADMIN_PASSWORD"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_ADMIN_USER" -d "$POSTGRES_DB" -v contract="$1" <<SQL
SELECT format('\''CREATE DATABASE %I OWNER console_app'\'', :'\''contract'\'')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'\''contract'\'')\gexec
SQL
' bash "$contract"
