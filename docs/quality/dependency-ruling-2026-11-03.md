<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# JWT crypto backend ruling — 2026-11-03

Owner approval, 2026-11-03: “approve aws-lc-rs”. The approval is limited to
`aws-lc-rs` as `jsonwebtoken`'s crypto backend in the backend platform layer.
It does not approve `jsonwebtoken`'s separate publisher and governance review,
enable FIPS mode, or permit another crypto backend.

`console-app`, `console-platform-auth` and `console-platform-push` resolve
`jsonwebtoken` with only `aws_lc_rs` and `use_pem`. This preserves ES256 access
tokens, RS256 service-account assertions and the feature-gated HS256 office
callback contract. `aws-lc-rs` 1.18.1 and `aws-lc-sys` 0.45.0 were already in
the lockfile through Rustls; the ruling adds no direct dependency.

The non-FIPS AWS-LC build uses the existing GCC/G++ toolchain in both platforms
of the Rust builder pinned by `deploy/versions.json`. Its [upstream build
requirements](https://aws.github.io/aws-lc-rs/requirements/index.html) do not
require a system CMake binary. `deploy/images/console.Dockerfile` uses that
builder, and the native arm64/amd64 matrix in `platform.yml` proves the release
image. No additional build tool is introduced by this ruling.

Compatibility proof is the shared JWT validation corpus, key-rotation and ES256
tests, release builds on Linux arm64 and amd64, and green Cargo deny/audit gates.
The existing P-256 dependency is updated separately to the patched line so the
retired timing-advisory exception is not retained through key parsing or test
fixtures; that version update is not a new provider approval.

Alternatives considered: the RustCrypto backend retained the affected arithmetic
path, and an in-house provider would duplicate security-sensitive JOSE code.
Exit requires signed-token validation parity, key-format compatibility, both
release builds and supply-chain gates before changing the backend or removing
AWS-LC.
