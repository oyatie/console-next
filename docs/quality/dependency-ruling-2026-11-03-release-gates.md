<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Release gate tooling

Owner approval, 2026-11-03: “approve oasdiff + grype”. This is explicit owner
approval, not a delegated ruling, limited to the CI/supply chain layer.

| Tool | License | Approved user | Release version | Linux amd64 archive SHA-256 |
| --- | --- | --- | --- | --- |
| oasdiff | Apache-2.0 | `.github/workflows/api-compat.yml` | 1.33.0 | `43a4e328e2d13ba1552d760aa68d2485c75c5621f309f6ff64ae895188345247` |
| grype | Apache-2.0 | `.github/workflows/platform.yml` | 0.120.0 | `a5a1218dce63acdac152a6b3b5bb366e7267e36f4069848cf455543b3fa5700e` |

`deploy/versions.json` records the release path's versions and SHA-256 pins for
Linux amd64/arm64 and macOS arm64; `deploy/ci/tools.py` verifies the downloaded
archive before extracting the binary. oasdiff uses the upstream binary release
corresponding to the release path's pinned 1.33.0 image. Grype's Linux archive
hashes match the release toolbox lock. macOS pins support local CI verification.

oasdiff compares the candidate OpenAPI contract with the released revision and
refuses breaking changes. Grype scans the published image's verified SPDX SBOM
and refuses fixable High/Critical vulnerabilities. Neither tool ships with the
application. Exact users, layer and approval source are recorded in the generated
architecture map and dependency register.

Alternatives considered: manual contract/advisory review, or repository code
duplicating OpenAPI compatibility and vulnerability matching. Exit: remove each
tool only after an owner-approved replacement proves the same refusal behavior;
then remove its pin and regenerate the register.
