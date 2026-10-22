// SPDX-License-Identifier: LicenseRef-Proprietary
use super::maturity::request;
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn malformed_grant_age_refuses_request_and_decision(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "ALTER TABLE tenant_setting_overrides DISABLE TRIGGER trg_tenant_setting_overrides_check",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    // Corrupt an override as the owner to simulate an unreadable policy; never silently use a literal default.
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'authz.second_person.min_grant_age','\"invalid\"'::jsonb,$2,'TEST')")
        .bind(org).bind(s.ops.id).execute(tx.as_mut()).await.unwrap();
    sqlx::query(
        "ALTER TABLE tenant_setting_overrides ENABLE TRIGGER trg_tenant_setting_overrides_check",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let (status, body, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let id = receipt["exception_id"].as_str().unwrap();
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"DECLINE", "reason_code":"DOCUMENT_MISMATCH"}),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM governed_exceptions WHERE subject_id=$1",
            s.entity
        )
        .await,
        1
    );
}
