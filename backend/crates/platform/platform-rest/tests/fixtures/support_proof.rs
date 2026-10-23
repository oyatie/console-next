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

pub(super) async fn operator(owner: &PgPool, rt: &PgPool, issuer: &JwtIssuer) -> Operator {
    let id = UserId::new();
    let roles = vec![Role::SuperAdmin.as_str().to_owned()];
    sqlx::query(
        "INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Support operator',$3)",
    )
    .bind(id.as_uuid())
    .bind(OrgId::platform().as_uuid())
    .bind(&roles)
    .execute(owner)
    .await
    .unwrap();
    let key = SoftKey::enroll(owner, OrgId::platform(), id).await;
    let token = token(rt, issuer, id, OrgId::platform(), true, roles).await;
    Operator { id, key, token }
}

pub(super) async fn token(
    pool: &PgPool,
    issuer: &JwtIssuer,
    user: UserId,
    org: OrgId,
    platform: bool,
    roles: Vec<String>,
) -> String {
    issue_session_token(
        pool,
        issuer,
        AccessTokenInput {
            subject: user,
            org_id: org,
            roles,
            branches: vec![],
            platform,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: vec![],
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        vec![],
    )
    .await
}
