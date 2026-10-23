// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn proof(
    owner: &PgPool,
    user: UserId,
    key: &mut SoftKey,
    id: Uuid,
    payload: Value,
) -> Value {
    let hash = Sha256::digest(serde_json::to_vec(&payload).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let binding =
        MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::SupportSession, id, hash);
    let ceremony = passkey_service()
        .start_mobile_step_up(owner, *user.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(ceremony.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    json!({"binding":binding,"assertion":{"ceremony_id":ceremony.ceremony_id,"credential":key.assert(&challenge).unwrap()}})
}
