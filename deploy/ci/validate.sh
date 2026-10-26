#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
if [[ $# == 0 ]]; then
  for environment in exit-test template; do
    node deploy/ci/render.mjs "${environment}" "example.invalid/console@sha256:$(printf 'a%.0s' {1..64})" ".tmp/validate-${environment}"
    bash "$0" ".tmp/validate-${environment}"
  done
  exit
fi
bundle="$1"
for group in objects namespace policies secrets database migrate app platform reconcile tests/backup tests/restore; do
  if [[ "${group}" == tests/* && ! -d "${bundle}/tests" ]]; then continue; fi
  [[ -d "${bundle}/${group}" ]] || { echo "PLAT_RENDER_GROUP: missing ${group}" >&2; exit 1; }
  kustomize build "${bundle}/${group}" > "${bundle}/${group}.yaml"
  kubeconform -strict -summary -kubernetes-version "$(jq -r .kubernetes deploy/versions.json)" \
    -schema-location 'deploy/schemas/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' "${bundle}/${group}.yaml"
  conftest test "${bundle}/${group}.yaml" -p deploy/policies/conftest
 done
