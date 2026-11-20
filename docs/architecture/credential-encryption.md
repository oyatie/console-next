<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Credential envelope encryption

The owner approved direct `aws-lc-rs` use on 2026-11-07 for credential envelope
encryption and RRN matching, and expanded the platform SDK mandate on
2026-11-20 to a dedicated crypto-agility SDK (`console-platform-crypto`) with the
AWS-ESDK-v2 key-committing construction (`alg_id = 3`). Its home is
frameworks & drivers/platform, with approved users `console-platform-crypto`,
`console-comms-credential-cipher`, and `console-app`. Domain/application ports
retain plain value types. The provider remains locked at 1.18.1 (non-FIPS
build, without claiming FIPS validation); no external crates are added.

`key_version` and `alg_id` / `kek_id` decouple the cryptographic suite from KEK
rotation:

| Version / `AlgId` | Canonical `alg_id` | Payload | DEK wrapping | Stored payload / wrap nonce | Key commitment |
| --- | --- | --- | --- | --- | --- |
| 1 | `legacy-xchacha20-poly1305` (`NULL` on legacy rows) | XChaCha20-Poly1305 | XChaCha20-Poly1305 | 24 / 24 bytes | None |
| 2 | `legacy-aes256-gcm-kwp` (`NULL` on legacy rows) | AES-256-GCM, 128-bit tag | Raw AES-256-KWP | 12 / 0 bytes | None |
| 3 | `aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp` | AES-256-GCM, 128-bit tag (`HKDF-SHA256` per-message `enc_key` from `(dek, msg_id)`) | `HKDF-SHA256` domain-separated AES-256-KWP keyed by `(kek_id, purpose)` | 12 / 0 bytes (+ 32B `msg_id`) | 256-bit `commitment_tag`, constant-time verified before GCM open |
| `0x0101` | `reserved-mlkem768-aes256-gcm` | Reserved PQ-hybrid suite | Reserved | Fail-closed (`UnsupportedAlgorithm`) | Reserved |

## Platform SDK & KMS Port (`console-platform-crypto`)

- **Decoupled `(alg_id, kek_id)` & `"CEV2"` wire codec**: `EnvelopeHeader` and
  `EnvelopeWire` separate algorithm suite selection from `KekId` rotation.
- **AWS-ESDK-v2 key-committing construction (`alg_id = 3`)**:
  - Generates fresh 32-byte `dek`, 32-byte `msg_id`, and 12-byte `nonce` per
    seal via `aws_lc_rs::rand::SystemRandom`.
  - Wraps `dek` via `KmsProvider::wrap_dek(purpose, &dek)` using `HKDF-SHA256`
    domain-separated `AES-256-KWP` (`AesKek`).
  - Derives per-message `enc_key` (256-bit) and `commitment_tag` (256-bit) via
    `HKDF-SHA256(salt = msg_id, ikm = dek)` with distinct domain info labels.
  - Binds `(alg_id, kek_id, wrapped_dek, msg_id, commitment_tag, tenant_id, table, record, field, purpose)`
    into the length-prefixed outer AES-256-GCM `AAD`.
  - On `open_v3`, unwraps `dek` strictly under `header.kek_id` (no cross-key
    fallback), re-derives `enc_key` and `expected_commit_tag`, checks
    `aws_lc_rs::constant_time::verify_slices_are_equal` **before** `AES_256_GCM`
    decryption, and returns opaque `CryptoError::Decrypt` on any failure.
- **Multi-key rotation keyring & KMS port**:
  - `KmsProvider` and `AsyncKmsProvider` decouple credential callers from key storage.
  - `LocalKeyringProvider` loads a multi-key rotation ring from
    `CONSOLE_MAIL_KEYRING` / `CONSOLE_RRN_KEYRING` JSON (`{"active":"...","keys":{...}}`)
    and/or falls back to `CONSOLE_MAIL_MASTER_KEY` / `CONSOLE_RRN_MASTER_KEY`
    under `"legacy-env-v1"` (supporting `<NAME>_FILE` via `secret_env`).
  - `OciVaultKmsProvider`, `AwsKmsProvider`, and `HsmKmsProvider` enforce HTTPS
    `rustls` TLS 1.2+ configuration with `SecretString` credentials, redacted
    `Debug`, and fail closed with `CryptoError::ProviderUnavailable` until remote
    wire activation.

## Schema & N-1 Rollback Contract

- This release keeps `CURRENT_KEY_VERSION = 1`: all runtime writers emit `v1` so
  a canary rollback to the previous `v1`-only binary can read every new row.
- Readers accept `v1`, `v2`, and `v3`, dispatch strictly by `key_version` /
  `alg_id`, never fall back after an authentication failure, and reject unknown
  or reserved (`0x0101`) suites.
- Additive expand migration (`20261120090000000_credential_crypto_agility_expand.sql`)
  adds nullable `alg_id`, `kek_id`, `smtp_msg_id` / `imap_msg_id` / `msg_id`,
  and `smtp_commitment_tag` / `imap_commitment_tag` / `commitment_tag` columns on
  `email_accounts`, `employee_rrn`, and `data_import_row_identities`, while
  companion contract migration `20261120090001000_credential_envelope_v3_shape.sql`
  widens the RRN shape checks to admit `key_version = 3`.
- RRN envelopes preserve `account_id = "employee_rrn"` / `field = "rrn"`
  (`table = "employee_rrn"`, `purpose = "rrn_vault"` in v3 outer AAD) so SQL
  staging promotion `INSERT INTO employee_rrn SELECT ... FROM data_import_row_identities`
  remains zero-copy compatible across `v1`, `v2`, and `v3`.

AES-KWP is the provider's [RFC 5649](https://www.rfc-editor.org/rfc/rfc5649)
implementation, standardized by [NIST SP 800-38F](https://doi.org/10.6028/NIST.SP.800-38F).
[NIST SP 800-38D §8.3](https://doi.org/10.6028/NIST.SP.800-38D) limits random-IV
GCM to 2^32 encryptions across all instances of a given key; one encryption per
fresh DEK stays below that bound.

The [official PIPC/KISA guide (2020.12), PDF page 13, table 1](https://www.privacy.go.kr/cmm/fms/FileDown.do?atchFileId=FILE_000000000841145&fileSn=0)
lists AES-128/192/256 among private-sector symmetric algorithm examples; ChaCha20
is absent. LEA appears in the public-sector examples. This example table is not
an exclusive statutory algorithm list or evidence of this build's certification.

HMAC-SHA256 uses `aws_lc_rs::hmac` with the unchanged separate matching key;
legacy index vectors remain byte-identical in this release. Keys and plaintext
are never logged.

## Scheduled contract

- After the dual-reader (`v1`/`v2`/`v3`) release is deployed across every
  environment, flip `CURRENT_KEY_VERSION` to `3` in a follow-on release once
  persisted SMTP/IMAP and both RRN-table compatibility tests pass.
- After the writer flip, run idempotent, resumable, audited batched re-sealing
  and remove legacy ChaCha20 only after zero `v1` rows remain.
