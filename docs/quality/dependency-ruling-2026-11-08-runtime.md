<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Backend runtime base

Delegated decision, recorded 2026-11-08: the basis is the 2026-10-26 owner ruling
approving distroless as the runtime family, plus the 2026-11-03 owner delegation
of clear enterprise best-practice decisions. Under that authority, the runtime
stays distroless/cc and moves from debian12 to the maintained debian13 release
to clear four High and one Critical OpenSSL CVEs. This records a delegated
maintenance decision, not a new explicit owner approval of Debian 13.
The existing CI/supply chain users remain `deploy` and
`deploy/images/console.Dockerfile`.

`deploy/versions.json` `images.runtime` is the sole digest authority. The Docker
build receives that value as `RUNTIME_IMAGE`; generated inventory derives from
the same lock. The upstream authority retains the Distroless keyless signer
`keyless@distroless.iam.gserviceaccount.com` and Google OIDC issuer.

The [registry tag listing](https://gcr.io/v2/distroless/cc-debian13/tags/list)
identifies the nonroot multiarch image. Its OpenSSL package is
`libssl3t64 3.5.7-1~deb13u3`, fixing CVE-2026-54874, CVE-2026-63072,
CVE-2026-63076, CVE-2026-75803 (DSA-6465-1) and CVE-2026-84782 (DSA-6531-1),
as recorded by the [Debian security tracker](https://security-tracker.debian.org/tracker/source-package/openssl).
Distroless build definitions are Apache-2.0; bundled Debian packages retain their
own licences, enumerated in the release SPDX SBOM.

The delegated STANDARD assessment is limited to that runtime and those users:

| Criterion | Assessment and evidence |
| --- | --- |
| a — standard choice | Preserve the owner's 2026-10-26 distroless runtime-family choice; no competing runtime family is introduced. |
| b — licence | [Distroless build definitions](https://github.com/GoogleContainerTools/distroless/blob/main/LICENSE) are Apache-2.0; the release SPDX SBOM retains the bundled Debian package licences. |
| c — maintenance | [Upstream](https://github.com/GoogleContainerTools/distroless#base-operating-system) maintains Debian 13 and deprecates Debian 12; the registry and Debian tracker above identify the patched artifact and package. |
| d — security and convention | Retain the signed, nonroot minimal runtime, with no added packages, and enforce the existing SBOM and fixable High/Critical gate. |
| e — architecture | The [backend architecture map](../architecture/backend-module-map.md) limits use to the existing CI/supply chain callers and records the exit plan. |

Keep the existing nonroot user, signature verification and strict fixable
High/Critical scan. No packages, ignores or severity exceptions are added.
The deprecated Debian 12 image still carries the five fixable findings;
waiting for it does not clear the release gate. Alternatives are Debian slim or a
separately reviewed static build on scratch. Replace the runtime only after
build, startup, signature and vulnerability-gate parity, then regenerate the
dependency register and architecture map.
