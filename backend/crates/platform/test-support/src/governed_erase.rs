// SPDX-License-Identifier: LicenseRef-Proprietary
//! Owner-only historical request fixture for existing force-removal closure tests.
//! HTTP tests exercise the passkey ceremonies and the live cooling boundary.
use sqlx::PgPool;
use uuid::Uuid;

pub async fn due(pool: &PgPool, target: Uuid, approver: Uuid) {
    let platform: Uuid = sqlx::query_scalar("SELECT id FROM organizations WHERE slug='platform'")
        .fetch_one(pool)
        .await
        .unwrap();
    let requester = Uuid::new_v4();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Erase fixture requester',ARRAY['SUPER_ADMIN'])")
        .bind(requester).bind(platform).execute(pool).await.unwrap();
    sqlx::query(
        "UPDATE users SET roles=ARRAY['SUPER_ADMIN'],is_active=true WHERE id=$1 AND org_id=$2",
    )
    .bind(approver)
    .bind(platform)
    .execute(pool)
    .await
    .unwrap();
    let mut assertions = Vec::new();
    for (user, action) in [(requester, "open"), (approver, "approve")] {
        let credential:Uuid=sqlx::query_scalar("INSERT INTO auth_webauthn_credentials(user_id,org_id,credential_id,passkey_json) VALUES($1,$2,$3,'{}') RETURNING id")
            .bind(user).bind(platform).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
        let assertion = Uuid::new_v4();
        sqlx::query("INSERT INTO step_up_assertions(ceremony_id,org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified,asserted_at) VALUES($1,$2,$3,$4,'OPERATOR_RECOVERY',$5,encode(digest('tenant_erase:'||$6||':'||$5||':'||$7,'sha256'),'hex'),true,now()-interval '8 days')")
            .bind(assertion).bind(platform).bind(user).bind(credential).bind(id).bind(target.to_string()).bind(action).execute(pool).await.unwrap();
        assertions.push(assertion);
    }
    sqlx::query("INSERT INTO tenant_erase_requests(org_id,id,target_org_id,requested_by,opened_at,open_assertion) VALUES($1,$2,$3,$4,now()-interval '8 days',$5)")
        .bind(platform).bind(id).bind(target).bind(requester).bind(assertions[0]).execute(pool).await.unwrap();
    sqlx::query("UPDATE tenant_erase_requests SET approved_by=$2,approved_at=now()-interval '8 days',cooling_until=now()-interval '1 day',approve_assertion=$3 WHERE id=$1")
        .bind(id).bind(approver).bind(assertions[1]).execute(pool).await.unwrap();
}
