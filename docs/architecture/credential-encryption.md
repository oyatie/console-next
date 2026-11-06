<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Credential envelope encryption

The owner approved direct `aws-lc-rs` use on 2026-11-07 for credential envelope
encryption and RRN matching. Its home is frameworks & drivers/platform, with
exact users `console-comms-credential-cipher` (AES-GCM, AES-KWP, randomness) and
`console-app` (HMAC-SHA256). Domain/application ports retain plain value types.
The provider is already locked at 1.18.1; no feature or transitive package is
added. This uses the existing non-FIPS build, without claiming FIPS validation.

`key_version` identifies the complete envelope/key suite, not a rotation counter:

| Version | Payload | DEK wrapping | Stored payload/wrap nonce |
| --- | --- | --- | --- |
| 1 | XChaCha20-Poly1305 | XChaCha20-Poly1305 | 24 / 24 bytes |
| 2 | AES-256-GCM, full 128-bit tag | AES-256-KWP | 12 / 0 bytes |

This release keeps `CURRENT_KEY_VERSION = 1`: all runtime writers emit v1 so
a canary rollback to the previous v1-only binary can read every new row.
Readers accept v1 and v2, dispatch strictly by version, never fall back after
an authentication failure, and reject unknown versions. SMTP and IMAP persist
independent versions because either password can be replaced alone. RRN import
staging and the employee vault accept both formats. Existing KEKs remain in
their Vault-injected environment variables; v2 does not change key material.
Future KEK rotation needs an explicit retained-key mapping and a new suite tag;
changing an environment key alone would make existing ciphertext unreadable.

AES-KWP is the provider's [RFC 5649](https://www.rfc-editor.org/rfc/rfc5649)
implementation, standardized by [NIST SP 800-38F](https://doi.org/10.6028/NIST.SP.800-38F).
It protects DEK confidentiality/integrity without a nonce. Each fresh random
256-bit DEK encrypts exactly one payload with a random 96-bit nonce and the
existing tenant/row/purpose AAD. A swapped wrapped DEK fails payload authentication.
[NIST SP 800-38D §8.3](https://doi.org/10.6028/NIST.SP.800-38D) limits random-IV
GCM to 2^32 encryptions across all instances of a given key. One encryption per
DEK stays below that bound; KWP removes the shared KEK's GCM invocation budget,
so correctness does not depend on an assumed write rate or rotation cadence.

The [official PIPC/KISA guide (2020.12), PDF page 13, table 1](https://www.privacy.go.kr/cmm/fms/FileDown.do?atchFileId=FILE_000000000841145&fileSn=0)
lists AES-128/192/256 among private-sector symmetric algorithm examples; ChaCha20
is absent. LEA appears in the public-sector examples. This example table is not
an exclusive statutory algorithm list or evidence of this build's certification.

HMAC-SHA256 uses `aws_lc_rs::hmac` with the unchanged separate matching key;
legacy index vectors must remain byte-identical. Keys and plaintext are never
logged. Legacy ChaCha remains writable during this expansion release. After
the writer flip, retain its reader until every environment's employee,
staged-import, SMTP and IMAP records have been re-sealed and zero v1 rows proven.
Drain v1-only binaries before allowing v2 writes: an old writer cannot maintain the
independent IMAP version when replacing a secret on an upgraded account.
Rollback after v2 writes requires a dual-reader release; the v1-only binary
cannot read v2 records. Provider replacement requires versioned-read, known-answer,
HMAC-index and persisted-envelope compatibility proof before retiring it.

## Scheduled contract

- After one release containing this dual reader has been deployed, flip
  `CURRENT_KEY_VERSION` to 2 in the following release. Admission:
  the released N-1 binary reads both suites, no v1-only writers remain, and
  persisted SMTP/IMAP and both RRN-table compatibility tests pass. Rollback must
  target that dual-reader release. Until then, explicit v2 sealing exists for
  compatibility tests; no runtime caller or background re-seal writes v2.
- After the writer flip, ship the idempotent, resumable, audited batched re-seal
  and remaining-v1 report; remove ChaCha only after every environment reports
  zero v1 rows. This release performs no re-seal and makes no zero-v1 claim.
