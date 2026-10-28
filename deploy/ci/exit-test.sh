#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Runner-only class B. No registry writes or OIDC signing; all inputs came from a dev push.
set -euo pipefail
mkdir -p .tmp/evidence .tmp/exit-bundle
started="${SECONDS}"
cluster="platform-exit-${REPETITION:-1}"
export KUBECONFIG="${RUNNER_TEMP:?}/platform-exit-${REPETITION:-1}.kubeconfig"
registry_config=''
cleanup() {
  result=$?
  set +e
  node deploy/ci/diagnostics.mjs > .tmp/evidence/diagnostics.txt 2>&1
  if (( result != 0 )); then
    cat .tmp/evidence/diagnostics.txt
  fi
  df -h > .tmp/evidence/disk.txt
  printf 'exit=%s\nduration_seconds=%s\narch=%s\n' "${result}" "$((SECONDS-started))" "$(uname -m)" > .tmp/evidence/result.txt
  kind delete cluster --name "${cluster}"
  if [[ -n "${registry_config}" ]]; then rm -rf -- "${registry_config}"; fi
  exit "${result}"
}
trap cleanup EXIT
# This login is shared with the disposable cluster, never the artifact or uploaded evidence.
registry_config="$(mktemp -d "${RUNNER_TEMP}/platform-registry.XXXXXX")"
export DOCKER_CONFIG="${registry_config}" PLATFORM_PULL_SECRET=console-exit-registry
printf '%s' "${REGISTRY_TOKEN:?}" | docker login ghcr.io --username "${GITHUB_ACTOR:?}" --password-stdin > /dev/null
repository="ghcr.io/${GITHUB_REPOSITORY,,}/console-deploy"
artifact="${ARTIFACT:-oci://${repository}:shadow}"
wrong="${WRONG_ARTIFACT:-oci://${repository}:shadow-wrong-identity}"
issuer=https://token.actions.githubusercontent.com
cosign verify --certificate-oidc-issuer="${issuer}" --certificate-identity="${PLATFORM_WORKFLOW_IDENTITY:?}" "${artifact#oci://}" > .tmp/evidence/artifact-signature.json
digest="$(jq -er '.[0].critical.image["docker-manifest-digest"]' .tmp/evidence/artifact-signature.json)"
artifact="oci://${repository}@${digest}"
flux pull artifact "${artifact}" --output=.tmp/exit-bundle
cp .tmp/exit-bundle/revision.json .tmp/evidence/revision.json
kind create cluster --name "${cluster}" --image "$(jq -r .images.kind deploy/versions.json)" --wait 120s
# Bootstrap only Flux; all other controllers and the stack are pulled through its verified source.
kubectl apply --server-side --field-manager=kustomize-controller -f .tmp/exit-bundle/platform/flux.yaml
kubectl rollout status -n flux-system deployment/source-controller --timeout=180s
kubectl rollout status -n flux-system deployment/kustomize-controller --timeout=180s
kubectl label namespace kube-system kube-public kube-node-lease default local-path-storage policy.sigstore.dev/exclude=true --overwrite
kubectl create secret generic "${PLATFORM_PULL_SECRET}" -n flux-system --type=kubernetes.io/dockerconfigjson --from-file=".dockerconfigjson=${DOCKER_CONFIG}/config.json"
ARTIFACT="${artifact}" node --input-type=module - <<'JS'
import fs from 'node:fs'; import yaml from 'js-yaml'; import {execFileSync} from 'node:child_process';
const source=yaml.load(fs.readFileSync('deploy/source/oci.yaml','utf8'));
const [url,digest]=process.env.ARTIFACT.split('@'); source.spec.url=url; source.spec.ref={digest};
source.spec.secretRef={name:process.env.PLATFORM_PULL_SECRET};
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
source.spec.verify.matchOIDCIdentity[0].subject=`^${escape(process.env.PLATFORM_WORKFLOW_IDENTITY)}$`;
execFileSync('kubectl',['apply','-f','-'],{input:yaml.dump(source),stdio:['pipe','inherit','inherit']});
JS
flux reconcile source oci console-deploy --timeout=120s
flux create kustomization platform --source=OCIRepository/console-deploy --path=./platform --prune --wait --interval=1m --timeout=8m
flux reconcile kustomization platform --timeout=10m
node deploy/ci/admission.mjs
# These secrets contain random synthetic credentials for this throwaway cluster only.
kubectl apply -f .tmp/exit-bundle/namespace/resources.yaml
kubectl create secret generic "${PLATFORM_PULL_SECRET}" -n console --type=kubernetes.io/dockerconfigjson --from-file=".dockerconfigjson=${DOCKER_CONFIG}/config.json"
kubectl apply --server-side -f - <<JSON
{"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"default","namespace":"console"},"imagePullSecrets":[{"name":"${PLATFORM_PULL_SECRET}"}]}
JSON
node deploy/ci/synthetic.mjs
flux create kustomization console-root --source=OCIRepository/console-deploy --path=./reconcile --prune --wait --interval=1m --timeout=20m
flux reconcile kustomization console-root --timeout=22m
kubectl rollout status deployment/console-worker -n console --timeout=120s
kubectl wait --for=jsonpath='{.status.phase}'=Healthy rollout/console-api -n console --timeout=180s
# Signature gate: trust the publisher; refuse unsigned bytes and the other workflow's signed bytes.
node deploy/ci/image-admission.mjs
# Source gate: first prove a REAL signature from the other workflow, then require Flux's identity refusal.
wrong_identity="${PLATFORM_WORKFLOW_IDENTITY/platform.yml/platform-negative-signer.yml}"
cosign verify --certificate-oidc-issuer="${issuer}" --certificate-identity="${wrong_identity}" "${wrong#oci://}" > .tmp/evidence/wrong-workflow-signature.json
wrong_digest="$(jq -er '.[0].critical.image["docker-manifest-digest"]' .tmp/evidence/wrong-workflow-signature.json)"
WRONG_ARTIFACT="oci://${repository}@${wrong_digest}" node --input-type=module - <<'JS'
import {execFileSync} from 'node:child_process';
const source=JSON.parse(execFileSync('kubectl',['get','ocirepository','console-deploy','-n','flux-system','-o','json']));
source.metadata={name:'wrong-workflow',namespace:'flux-system'};delete source.status;
const [url,digest]=process.env.WRONG_ARTIFACT.split('@');source.spec.url=url;source.spec.ref={digest};
execFileSync('kubectl',['apply','-f','-'],{input:JSON.stringify(source),stdio:['pipe','inherit','inherit']});
JS
if ! kubectl wait --for=condition=Ready=False ocirepository/wrong-workflow -n flux-system --timeout=120s > .tmp/evidence/wrong-workflow.txt 2>&1; then
  echo 'PLAT_ARTIFACT_IDENTITY: source did not report Ready=False before the deadline' >&2; exit 1
fi
kubectl get ocirepository wrong-workflow -n flux-system -o json > .tmp/evidence/wrong-workflow.json
if ! jq -e '.metadata.generation as $generation | (.status.conditions // []) |
  any(.type == "Ready" and .status == "False" and .reason == "VerificationError" and .observedGeneration == $generation) and
  any(.type == "SourceVerified" and .status == "False" and .reason == "VerificationError" and .observedGeneration == $generation)' .tmp/evidence/wrong-workflow.json; then
  echo 'PLAT_ARTIFACT_IDENTITY: expected current Ready=False and SourceVerified=False with VerificationError' >&2; exit 1
fi
# Drift control: neither scale nor apply the expected value directly; Flux restores the artifact's desired count.
expected="$(kubectl get deployment console-worker -n console -o jsonpath='{.spec.replicas}')"
kubectl scale deployment console-worker -n console --replicas=0
flux reconcile kustomization console-app --timeout=180s
actual="$(kubectl get deployment console-worker -n console -o jsonpath='{.spec.replicas}')"
printf 'edited=0\nexpected=%s\nreconciled=%s\n' "${expected}" "${actual}" > .tmp/evidence/drift.txt
if ! test "${actual}" = "${expected}"; then
  printf 'FLUX_DRIFT: console-worker expected=%s reconciled=%s\n' "${expected}" "${actual}" >&2; exit 1
fi
# Real console HTTP contracts, against the CNPG-backed application (never the memory adapters).
kubectl port-forward -n console service/console-api 18080:8080 > .tmp/port-forward.log 2>&1 &
forward_pid=$!
export PLATFORM_TEST_URL=http://localhost:18080
curl --fail --silent --retry 20 --retry-connrefused --retry-delay 1 "${PLATFORM_TEST_URL}/readyz" > .tmp/evidence/ready.json
if ! node --test deploy/ci/stack.e2e.mjs > .tmp/evidence/e2e.txt 2>&1; then
  echo 'PLAT_STACK: console HTTP contract failed' >&2
  cat .tmp/evidence/e2e.txt >&2
  exit 1
fi
kill "${forward_pid}"
node deploy/ci/canary.mjs
node deploy/ci/restore.mjs
printf 'PLAT_UNSIGNED_IMAGE=refused\nPLAT_IMAGE_IDENTITY=refused\nPLAT_ARTIFACT_IDENTITY=refused\nFLUX_DRIFT=reverted\nSTACK=ready\n' > .tmp/evidence/controls.txt
