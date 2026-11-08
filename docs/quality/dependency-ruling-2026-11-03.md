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

## Addendum — 2026-11-07: direct envelope and HMAC use

The owner approved `aws-lc-rs` as a direct workspace dependency on 2026-11-07,
replacing XChaCha20-Poly1305 with AES-256-GCM: “no reason to pick
chacha20poly1305 over aes-256-gcm”. This extends the 2026-11-03 JWT-only scope
and the 2026-10-26 “aws-lc-rs everywhere” direction to AES-256-GCM payloads,
AES-256-KWP DEK wrapping, HMAC-SHA256 matching and CSPRNG use for credential/RRN
envelopes. The exact direct users are `console-comms-credential-cipher` and
`console-app`, in frameworks & drivers/platform; ports remain provider-free.

The [credential encryption architecture](../architecture/credential-encryption.md)
records the suites, invocation limits and two-release rollout. The canonical
`cargo:aws-lc-rs` review in `scripts/quality/tooling-reviews.json` records these
users, layer and shipped features. Version 1.18.1 retains default features
`aws-lc-sys`, `alloc`, `ring-io` and `ring-sig-verify`; workspace unification also
includes the existing `prebuilt-nasm` feature. FIPS mode remains disabled.
No new transitive package, build tool or jsonwebtoken governance approval is
introduced. The earlier statement that there is no direct dependency describes
the 2026-11-03 ruling only; this dated addendum supersedes that restriction.
