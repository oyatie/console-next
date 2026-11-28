// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrations = false)]
async fn access_review_upgrade_preserves_existing_invite_receipt(pool: PgPool) {
    let migrator = &console_platform_test_support::MIGRATOR;
    migrator.run_to(20261126170001000, &pool).await.unwrap();
    sqlx::query(
        "INSERT INTO api_idempotency_keys(org_id,operation,idempotency_key,request_fingerprint,response)
         VALUES ('00000000-0000-0000-0000-00000000face','access.invites.create','older-invite-receipt',repeat('0',64),jsonb_build_object('otp',NULL))",
    ).execute(&pool).await.unwrap();
    let actor: Uuid = sqlx::query_scalar(
        "INSERT INTO users (org_id,display_name,roles)
        VALUES ('00000000-0000-0000-0000-00000000face','Receipt Fixture','{}') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let legacy: Uuid = sqlx::query_scalar(
        "INSERT INTO command_outcomes(org_id,actor_id,idempotency_key,command,request_fingerprint,state,settled_at,result)
         VALUES ('00000000-0000-0000-0000-00000000face',$1,'older-invite-receipt','POST /api/v1/access/invites',
                    repeat('0',64),'APPLIED',now(),jsonb_build_object('otp','synthetic-test-value')) RETURNING id"
    ).bind(actor).fetch_one(&pool).await.unwrap();
    migrator.run(&pool).await.unwrap();
    let cleared: bool = sqlx::query_scalar(
        "SELECT result IS NULL AND state='APPLIED' FROM command_outcomes WHERE id=$1",
    )
    .bind(legacy)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(cleared);
    let receipt: Value = sqlx::query_scalar(
        "SELECT response FROM api_idempotency_keys WHERE idempotency_key='older-invite-receipt'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(receipt, json!({"otp":null}));
}
