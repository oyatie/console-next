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

- **Default writer (`CURRENT_KEY_VERSION = 3`)**: All runtime writers (`AccountService`
  for `email_accounts` SMTP/IMAP and `EnvRrnVault` for `employee_rrn` /
  `data_import_row_identities`) emit `key_version = 3` (`alg_id = "aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp"`),
  tagging each row with the active `kek_id` from `CONSOLE_*_KEYRING` (or `"legacy-env-v1"`
  when only `CONSOLE_*_MASTER_KEY` is configured).
- **Dual-read & N-1 rollback safety**: Readers continue to accept `v1` (`XChaCha20-Poly1305`),
  `v2` (`AES-256-GCM + AES-256-KWP`), and `v3` (`AWS-ESDK-v2`), dispatching strictly
  by `key_version` / `alg_id`, never falling back after an authentication failure,
  and rejecting unknown or reserved (`0x0101`) suites. Because the previous release
  already ships `v3` readers, rows written as `v3` remain decryptable on N-1
  rollback, and any `v1` rows written during rollback are readable and re-sealed
  on roll-forward.
- **Schema expand & contract constraints**:
  - `20261120090000000_credential_crypto_agility_expand.sql` adds nullable
    `alg_id`, `kek_id`, `*_msg_id`, and `*_commitment_tag` columns on
    `email_accounts`, `employee_rrn`, and `data_import_row_identities`.
  - `20261120143000000_credential_envelope_v3_shape_fix.sql` (`-- contract-of: 20261120090000000`)
    fixes SQL three-valued logic (`3VL`) by wrapping `employee_rrn_envelope_shape`
    and `data_import_row_identities_envelope_shape` in `(...) IS TRUE` with explicit
    `msg_id IS NOT NULL AND commitment_tag IS NOT NULL` and `alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp'`,
    and adds `email_accounts_smtp_envelope_shape` and `email_accounts_imap_envelope_shape`
    with `NOT VALID` + `VALIDATE CONSTRAINT` (`v1`/`v2` permissive for legacy fixtures,
    strict `v3` invariants enforced).
  - `20261120143001000_data_import_row_identities_org_immutable.sql` and
    `20261120143002000_credential_reseal_grants.sql` enforce `org_id` immutability
    on `data_import_row_identities` and grant `console_rt` column-scoped `UPDATE`
    strictly on the 9 envelope columns (`ciphertext`, `nonce`, `dek_wrapped`,
    `dek_nonce`, `key_version`, `alg_id`, `kek_id`, `msg_id`, `commitment_tag`) of
    `employee_rrn` and `data_import_row_identities`, keeping identity, blind-index `v1`,
    masked display, and provenance columns immutable.
- RRN envelopes preserve `account_id = "employee_rrn"` / `field = "rrn"`
  (`table = "employee_rrn"`, `purpose = "rrn_vault"` in v3 outer AAD) across both
  `employee_rrn` and `data_import_row_identities` so SQL staging promotion
  `INSERT INTO employee_rrn SELECT ... FROM data_import_row_identities` and
  staged-identity re-sealing remain decryptable across rotations.

## Audited Batched Re-Seal & Census

- **Zero-copy re-sealing**: `EnvelopeCredentialCipher::reseal` (via `open_with`)
  and `EnvRrnVault::reseal` decrypt inside `SecretBox` and re-seal under `v3` and
  `active_kek_id()`, preserving RRN blind indexes (`rrn_hmac`, `rrn_hmac_v2`) and
  `masked`.
- **RLS-armed worker & store methods**:
  - `HrService::reseal_rrn_envelopes` re-seals `employee_rrn` and
    `data_import_row_identities` in `FOR UPDATE SKIP LOCKED` batches inside
    `with_audits`, recording `AuditSource::Scheduler` events (`employee.rrn_envelope_reseal`,
    `import.staged_identity_envelope_reseal`) with non-PII counts and `(alg_id, kek_id)`
    transitions only.
  - `PgMailStore::reseal_email_accounts` independently re-seals stale SMTP and IMAP
    envelopes on `email_accounts` (`updated_at = now()`) with `AuditSource::Scheduler`
    events (`email.account_credential_reseal`).
  - `HrService::legacy_envelope_census` and `PgMailStore::legacy_envelope_census`
    report per-table `v1`, `v2`, `v3_stale_kek`, and `v3_current` counts under
    `with_org_conn`.
- **Worker loop & one-shot CLI**: `lifecycle_schedule::spawn` invokes
  `crypto_reseal::run_worker_tick` in `AppRole::Worker`; operators can drain or
  inspect progress on demand via `console-app crypto-reseal [--batch-size N] [--max-batches N]`
  and `console-app crypto-census` (connecting strictly as `console_rt` and emitting
  non-PII JSON counts to stdout).

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

- Remove legacy ChaCha20 (`chacha20poly1305`) and `v1`/`v2` reader arms only in
  a subsequent contract release after `console-app crypto-census` confirms
  `v1 == 0` and `v2 == 0` across all three tables and N-1 binaries are retired.
- Drop legacy `rrn_hmac` (`v1`) only in a future contract migration after N-1
  binaries are retired and `WHERE rrn_hmac_v2 IS NULL` reaches zero.

## Per-Tenant Key Hierarchy & Crypto-Shredding

- **Per-tenant DEK wrapping (`tenant_encryption_keys`)**:
  - Each organization maintains scoped data-encryption keys (`key_scope IN ('rrn', 'mail')`,
    monotonically versioned `key_version >= 1`, `state IN ('ACTIVE', 'RETIRED', 'SHREDDED')`,
    `UNIQUE (org_id, key_scope) WHERE (state = 'ACTIVE')`).
  - Wrapped tenant DEKs are encrypted under the master KEK using `HKDF-SHA256`
    domain-separated AES-256-KWP (`purpose = "tenant_dek.rrn"` / `"tenant_dek.mail"`),
    identified on stored rows via `kek_id = "tdek:<org_uuid>:<scope>:v<ver>"`.
  - `PgTenantKeyStore` lazily provisions `v1` in `CONSOLE_TENANT_DEK_MODE=active`
    (the default) under an advisory transaction lock and caches unwrapped DEKs in
    `TenantDekCache` keyed by `(org_id, scope, version, sha256(wrapped_dek))`.
    Canary rollouts may set `CONSOLE_TENANT_DEK_MODE=dual_read` to write new
    envelopes under the global master KEK while continuing to unwrap both direct-KEK
    and `tdek:...` envelopes.
  - Once any row in `tenant_encryption_keys` enters `SHREDDED`, runtime key
    resolution refuses auto-reprovisioning and fails closed; database triggers
    prevent deletion or un-shredding of `SHREDDED` tombstones, and `SHREDDED`
    rows survive `DELETE FROM organizations`.
- **Two-operator crypto-shredding & PITR survivability**:
  - `platform_force_remove_organization_command` atomically captures S3 object keys
    into `tenant_erase_s3_outbox`, transitions `tenant_encryption_keys` rows to
    `state = 'SHREDDED'` with `wrapped_dek = NULL`, deletes tenant data inside
    `platform_force_remove_organization`, and appends a zero-PII `'tenant_dek'`
    witness entry to `erasure_ledger` alongside `tenant_erase_requests` witness
    columns (`erasure_witness_seq`, `erasure_witness_hash`,
    `shredded_key_fingerprint`) and `audit_events`.
  - Even if database or storage snapshots from prior to erasure are restored,
    erased tenant ciphertexts remain permanently unrecoverable without the shredded
    tenant DEKs, while `erasure_ledger` hash-chain verification and out-of-process
    witness logs (`console.erasure_ledger.witness`) attest the erasure event.
  - `PlatformProvisioner::drain_erased_tenant_objects` drains
    `tenant_erase_s3_outbox` post-commit without holding DB transactions across
    HTTP object-store calls, treating `404`/`NoSuchKey` as purged and deferring
    WORM-locked replica `403`/retention errors for 24 hours.

## Unified Cryptographic Stack & Custody Transport

- Workspace TLS (`rustls` / `tokio-rustls`), IMAP TLS (`console-comms-adapter-imap`),
  audit-chain Ed25519 signing/verification (`console-platform-audit-chain`), and
  provisioning hashing (`console-platform-provisioning`) run on `aws-lc-rs`,
  eliminating duplicate `ring` and legacy `sha2` direct edges.
- `HttpCustodyTransport` delegates audit-chain seal signing over `reqwest` (`rustls`
  TLS 1.2+) on a dedicated `current_thread` runtime thread, permitting `http://`
  only for loopback hosts, refusing redirects, enforcing a 5s timeout and 8 KiB
  streaming response cap, and trusting optional custom CAs from
  `CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE`.
