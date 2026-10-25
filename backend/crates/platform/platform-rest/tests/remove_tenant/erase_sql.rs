// SPDX-License-Identifier: LicenseRef-Proprietary
//! Runtime SQL cannot shorten a genuine approval's cooling window or revive a cancellation.
use super::*;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope};
use console_platform_provisioning::TenantEraseCommand;
use console_platform_test_support::soft_passkey::passkey_service;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_cannot_backdate_approval_or_resurrect_cancelled_erasure(owner: PgPool) {
    let h = Harness::new(&owner).await;
    let a = seed_platform_admin(&owner).await;
    let b = seed_platform_admin(&owner).await;
    let at = h.token(a, OrgId::platform(), true).await;
    let bt = h.token(b, OrgId::platform(), true).await;
    let mut ak = real_key(&owner, a).await;
    let mut bk = real_key(&owner, b).await;
    let org = onboard(&h.service(), &at, "erase-sql-guard").await;
    archive_org(&h.service(), &at, org).await;
    let id = Uuid::new_v4();
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for (approved, cooling) in [("-8 days", "-1 day"), ("1 day", "8 days")] {
        let proof = operator_proof::proof(
            &owner,
            *b.as_uuid(),
            &mut bk,
            id,
            TenantEraseCommand::Approve.payload_hash(org, id),
        )
        .await;
        let binding: MobilePasskeyStepUpBinding =
            serde_json::from_value(proof["binding"].clone()).unwrap();
        let envelope: MobilePasskeyStepUpEnvelope = serde_json::from_value(proof).unwrap();
        let mut tx = h.rt_pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(OrgId::platform().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let assertion = passkey_service()
            .verify_and_record_step_up_in_tx(&mut tx, envelope, *b.as_uuid(), &binding)
            .await
            .unwrap();
        sqlx::query("SAVEPOINT proof_clock_privilege")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let clock_error=sqlx::query("INSERT INTO step_up_assertions(ceremony_id,org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified,asserted_at) SELECT gen_random_uuid(),org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified,clock_timestamp()-interval '8 days' FROM step_up_assertions WHERE ceremony_id=$1")
            .bind(assertion).execute(tx.as_mut()).await.expect_err("runtime cannot supply its own proof timestamp");
        assert_eq!(
            clock_error.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
        sqlx::query("ROLLBACK TO SAVEPOINT proof_clock_privilege")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let result=sqlx::query("UPDATE tenant_erase_requests SET approved_by=$2,approve_assertion=$3,approved_at=clock_timestamp()+$4::interval,cooling_until=clock_timestamp()+$5::interval WHERE id=$1")
            .bind(id).bind(b.as_uuid()).bind(assertion).bind(approved).bind(cooling).execute(tx.as_mut()).await;
        let error = result
            .expect_err("a valid approval proof cannot backdate or future-date its cooling window");
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        tx.rollback().await.unwrap();
    }
    let (status, body) = command(&h, &owner, b, &mut bk, &bt, org, id, "approve").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "cancel").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut tx = h.rt_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::platform().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = sqlx::query(
        "UPDATE tenant_erase_requests SET cancelled_by=NULL,cancelled_at=NULL WHERE id=$1",
    )
    .bind(id)
    .execute(tx.as_mut())
    .await
    .expect_err("a cancelled erasure is terminal at the runtime database boundary");
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55000")
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        PlatformProvisioner::run_due_tenant_erases(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    assert!(org_exists(&owner, org).await);
}
