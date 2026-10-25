// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared soft-passkey proof for operator commands; callers supply the domain binding.
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
pub(super) async fn proof(
    pool: &PgPool,
    user: Uuid,
    key: &mut SoftKey,
    id: Uuid,
    hash: String,
) -> Value {
    let binding =
        MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::OperatorRecovery, id, hash);
    let start = passkey_service()
        .start_mobile_step_up(pool, user, binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}})
}
