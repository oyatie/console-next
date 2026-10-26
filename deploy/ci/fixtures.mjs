// SPDX-License-Identifier: LicenseRef-Proprietary
export const pod = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'fixture' }, spec: {
  securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
  containers: [{ name: 'app', image: `example.invalid/console@sha256:${'a'.repeat(64)}`,
    securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } } }],
} });
export const refusals = {
  'PLAT_IMAGE_DIGEST': p => { p.spec.containers[0].image = 'console:latest'; },
  'PLAT_NON_ROOT': p => { p.spec.securityContext.runAsNonRoot = false; },
  'PLAT_READ_ONLY': p => { p.spec.containers[0].securityContext.readOnlyRootFilesystem = false; },
  'PLAT_RESOURCES': p => { delete p.spec.containers[0].resources.limits; },
  'PLAT_HOST_PATH': p => { p.spec.volumes = [{ name: 'host', hostPath: { path: '/' } }]; },
  'PLAT_PRIVILEGE': p => { p.spec.containers[0].securityContext.allowPrivilegeEscalation = true; },
  'PLAT_HOST_NAMESPACE': p => { p.spec.hostNetwork = true; },
  'PLAT_SECCOMP': p => { p.spec.securityContext.seccompProfile.type = 'Unconfined'; },
};
