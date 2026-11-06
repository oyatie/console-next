// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_amendment_uses_runtime_role_without_updating_immutable_close_and_replays_idempotently(
    owner_pool: PgPool,
) {
    scope_org(OrgId::one(), async move {
        let branch = seed_branch(&owner_pool, "attendance-amendment", "operations").await;
        let actor = seed_user(&owner_pool, "Attendance Amendment Manager", "ADMIN", branch).await;
        let caller = branch_caller(actor, branch);
        let store = PgAttendanceStore::new(runtime_role_pool(&owner_pool).await);
        let close = store
            .close_month(
                &caller,
                CloseMonth {
                    month: CLOSE_MONTH.to_owned(),
                    branch_scope: Some(*branch.as_uuid()),
                    attest: true,
                },
            )
            .await
            .expect("runtime role must create the immutable branch close snapshot");
        let command = AmendClose {
            close_id: close.id,
            reason: "approved correction".to_owned(),
            detail: "manager corrected the source evidence after close".to_owned(),
            reference: Some("ATTENDANCE-31".to_owned()),
            idempotency_key: "attendance-close-amendment-0001".to_owned(),
        };

        let stored: (time::OffsetDateTime, time::OffsetDateTime) = sqlx::query_as(
            "SELECT attested_at,closed_at FROM attendance_month_closes WHERE id=$1",
        )
        .bind(close.id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        assert_eq!((close.attested_at, close.closed_at), stored);

        let amendment = store
            .amend_close(&caller, command.clone())
            .await
            .expect("runtime role must append an amendment without updating the immutable close");
        let replay = store
            .amend_close(&caller, command.clone())
            .await
            .expect("an exact amendment replay must return the original immutable amendment");
        assert_eq!(replay.id, amendment.id, "exact replay returns the one amendment");

        let amendment_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM attendance_close_amendments WHERE org_id=$1 AND close_id=$2",
        )
        .bind(*OrgId::one().as_uuid())
        .bind(close.id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='attendance.close.amend' AND target_id=$2",
        )
        .bind(*OrgId::one().as_uuid())
        .bind(close.id.to_string())
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        assert_eq!(amendment_count, 1, "one immutable amendment is durable");
        assert_eq!(audit_count, 1, "only the initial append emits an audit");

        let mut changed = command;
        changed.detail = "changed immutable amendment detail".to_owned();
        let conflict = store
            .amend_close(&caller, changed)
            .await
            .expect_err("changing a replay payload must conflict");
        assert!(matches!(conflict, AttendanceStoreError::Conflict));

        let amendments_after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM attendance_close_amendments WHERE org_id=$1 AND close_id=$2",
        )
        .bind(*OrgId::one().as_uuid())
        .bind(close.id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        let audits_after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='attendance.close.amend' AND target_id=$2",
        )
        .bind(*OrgId::one().as_uuid())
        .bind(close.id.to_string())
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        assert_eq!(amendments_after, 1, "conflicting replay cannot append another amendment");
        assert_eq!(audits_after, 1, "conflicting replay cannot emit another audit");
    })
    .await;
}
