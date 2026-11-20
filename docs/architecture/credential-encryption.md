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

## Tenant-Bound RRN Blind Index (v2+)

- **HKDF-SHA256 tenant/context separation (`console-platform-crypto/src/blind_index.rs`)**:
  - `BlindIndexKeyring` holds versioned 32-byte root keys inside `SecretBox<[u8; 32]>`
    with redacted `Debug`, loaded from `CONSOLE_RRN_HMAC_KEYRING`
    (`{"active": N, "keys": {"1": "<b64>", "2": "<b64>", ...}}`) and/or legacy
    `CONSOLE_RRN_HMAC_KEY` (with `<NAME>_FILE` support via `secret_env`).
  - When only `CONSOLE_RRN_HMAC_KEY` is configured, version `1` (legacy raw
    `HMAC-SHA256`) and version `2` (HKDF-SHA256 root) are both registered with
    `active_version = 2`; conflicting version `1` bytes when both env vars are
    set fail closed via constant-time `aws_lc_rs::constant_time::verify_slices_are_equal`.
  - For `version >= 2`, `HKDF-SHA256(salt = "console.crypto.blind_index.salt.v2", ikm = key_v, info = "console.crypto.blind_index.v2" || LP_u32(org_id) || LP_u32(table) || LP_u32(field) || u16_be(version))`
    derives a 32-byte `Zeroizing` subkey before `HMAC-SHA256(subkey, rrn.digits())`.
  - Both `employee_rrn` and staged `data_import_row_identities` bind
    `table = "employee_rrn"` and `field = "rrn"` so import staging, dry-run
    matching, promotion, and form recording remain invariant per tenant while
    making cross-tenant blind indexes cryptographically unlinkable.
- **Expand schema, dual-write/dual-read, and N-1 rollback safety**:
  - Additive migration `20261120110000000_rrn_blind_index_v2_expand.sql` adds
    nullable `rrn_hmac_v2` and `blind_index_version` to `employee_rrn` and
    `data_import_row_identities`, plus column-scoped
    `GRANT UPDATE (rrn_hmac_v2, blind_index_version) ON employee_rrn TO console_rt;`.
  - Companion `-- no-transaction` migration `20261120110001000_rrn_blind_index_v2_idx.sql`
    creates non-unique partial `employee_rrn_hmac_v2_idx` (`CONCURRENTLY`).
  - Writers dual-write both legacy `rrn_hmac` (`v1`) and tenant-bound `rrn_hmac_v2`
    (`v2+`) so an N-1 rollback remains lossless during rollout; readers dual-read
    `v2+` candidates when `rrn_hmac_v2 IS NOT NULL` and fall back to `rrn_hmac`
    only when `rrn_hmac_v2 IS NULL`.
- **Audited batched backfill (`HrService::backfill_rrn_blind_indexes`)**:
  - Scheduled worker loop iterates tenants via `platform_list_organizations()`,
    probes under `with_org_conn`, claims up to `100` rows per batch via
    `FOR UPDATE SKIP LOCKED` inside `with_audits`, recomputes `rrn_hmac_v2` /
    `blind_index_version` inside the vault (`rekey_blind_index_v2`), leaves
    `rrn_hmac` untouched for N-1 safety, and records one `AuditEvent`
    (`actor = None`, `AuditSource::Scheduler`, action `employee.rrn_blind_index_backfill`)
    containing only updated counts and target version (never RRN or HMAC bytes).
- **Redacted `Debug` & `SecretBox` boundaries**: `SealedRrn`, `ImportRow`,
  `OnFile`, `EnvRrnVault`, and `BlindIndexKeyring` redact RRN digits, masked
  values, blind-index bytes, and key material in `fmt::Debug`; `EnvRrnVault::open`
  parses inside `EnvelopeCredentialCipher::open_with` without copying plaintext
  RRN digits into an unzeroized `Vec<u8>`. Keys and plaintext are never logged.

## Scheduled contract

- After the dual-reader (`v1`/`v2`/`v3`) release is deployed across every
  environment, flip `CURRENT_KEY_VERSION` to `3` in a follow-on release once
  persisted SMTP/IMAP and both RRN-table compatibility tests pass.
- After the writer flip, run idempotent, resumable, audited batched re-sealing
  and remove legacy ChaCha20 only after zero `v1` rows remain.
- Drop legacy `rrn_hmac` (`v1`) only in a future contract migration after N-1
  binaries are retired and `WHERE rrn_hmac_v2 IS NULL` reaches zero.
