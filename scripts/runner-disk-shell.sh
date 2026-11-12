#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
label="${1##*/}"
exec node "$GITHUB_WORKSPACE/scripts/runner-disk.mjs" "${label%.sh}" bash --noprofile --norc -e -o pipefail "$@"
