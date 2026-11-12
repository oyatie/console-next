// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reviewer_people_and_ops_are_preserved_at_two_thousand_accounts(owner: PgPool) {
    let (app, issuer) = router(&owner).await;
    let svc = passkey_service();
    let org = OrgId::new();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Review scale')")
        .bind(org.as_uuid())
        .bind(org.to_string())
        .execute(&owner)
        .await
        .unwrap();
    let mut human = admin_in(&owner, &svc, &issuer, org, "요청자").await;
    let ops = admin_in(&owner, &svc, &issuer, org, "운영 계정").await;
    sqlx::query("UPDATE users SET employee_id=NULL,is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let unlocked = unlock(&owner, &app, &mut human).await;
    grant_review(&owner, org, human.id, ops.id).await;
    let alias = admin_in(&owner, &svc, &issuer, org, "같은 사람의 계정").await;
    sqlx::query("UPDATE users SET employee_id=NULL,person_id=(SELECT person_id FROM users WHERE id=$2) WHERE id=$1")
        .bind(alias.id).bind(human.id).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,$2,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM access_grants WHERE account_id=$1")
        .bind(human.id).bind(alias.id).execute(&owner).await.unwrap();
    assert_eq!(reviews(&app, &ops.token).await.len(), 1);
    sqlx::query("INSERT INTO users(org_id,display_name,roles) SELECT $1,'일반 계정',ARRAY['MEMBER'] FROM generate_series(1,1997)")
        .bind(org.as_uuid()).execute(&owner).await.unwrap();
    assert_eq!(reviews(&app, &ops.token).await.len(), 1);
    assert!(reviews(&app, &human.token).await.is_empty());
    assert!(reviews(&app, &alias.token).await.is_empty());
    let (status, body) = send(&app, &review_path(&unlocked), &alias.token, None, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["error"]["message"],
        "another close authority must review this unlock"
    );
    let (status, body) = send(&app, &review_path(&unlocked), &ops.token, None, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(reviews(&app, &ops.token).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn break_glass_without_a_review_task_keeps_its_warning(owner: PgPool) {
    let (app, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut human = admin_in(&owner, &svc, &issuer, OrgId::one(), "요청자").await;
    let ops = admin_in(&owner, &svc, &issuer, OrgId::one(), "운영 계정").await;
    sqlx::query("UPDATE users SET employee_id=NULL,is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let solo = unlock(&owner, &app, &mut human).await;
    let checker = admin_in(&owner, &svc, &issuer, OrgId::one(), "확인자").await;
    // Persist the historical break-glass writer's shape with independent bound people.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::one().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let break_glass: Uuid = sqlx::query_scalar("INSERT INTO period_locks(org_id,domain,period_start,period_end,reason_code,unlocked_at,unlocked_by,unlock_reason_code,relock_at,unlock_approved_by,unlock_review_required) VALUES($1,'payroll','2026-05-01','2026-05-31','MONTHLY_PAYROLL_CLOSE',now(),$2,'PAYROLL_ERROR',now()+interval '1 day',$3,true) RETURNING id")
        .bind(OrgId::one().as_uuid()).bind(human.id).bind(checker.id).fetch_one(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (status, body) = send(&app, &review_path(&solo), &ops.token, None, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, locks) = read(&app, &format!("{LOCKS}?active=false"), &ops.token).await;
    assert_eq!(status, StatusCode::OK, "{locks}");
    let items = locks["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .find(|l| l["id"] == solo["lock"]["id"])
            .unwrap()["unlockReviewRequired"],
        false
    );
    assert_eq!(
        items
            .iter()
            .find(|l| l["id"] == break_glass.to_string())
            .unwrap()["unlockReviewRequired"],
        true
    );
}
