// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service recovery contact encryption (AWS-ESDK-v2 `alg_id = 3`), 10-code
//! single-use HMAC recovery batch generation, and pre-auth recovery sign-in.

mod challenge;
mod codes;
mod contact_store;
mod crypto;
mod redeem;

pub use challenge::{
    RecoveryChallengeIssue, cancel_open_ops_recovery_on_holder_login_tx, issue_recovery_challenge,
};
pub use codes::{
    RECOVERY_CODE_COUNT, RecoveryCodesBatch, RecoveryCodesSummary, generate_recovery_codes,
    generate_recovery_codes_tx, hash_recovery_challenge, hash_recovery_code,
    load_recovery_codes_summary_tx,
};
pub use contact_store::{
    decrypt_recovery_contact_tx, load_recovery_contact_status_tx, upsert_recovery_contact,
    upsert_recovery_contact_tx,
};
pub use crypto::{
    RECOVERY_CONTACT_NOTICE_VERSION, RecoveryChannel, RecoveryContactCipher, RecoveryContactStatus,
    mask_recovery_contact,
};
pub use redeem::{RecoveryCodeRedemption, redeem_recovery_code_in_tx};
pub use secrecy::ExposeSecret;
