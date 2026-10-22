// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "fixtures/ops_recovery.rs"]
mod fixture;
use console_kernel_core::OrgId;
use console_platform_provisioning::OpsRecoveryCommand as C;
use fixture::*;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_events_and_actor_names_follow_each_committed_step(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let id = h.approved().await;
    let read =
        h.p.read_ops_recovery(&h.runtime, h.org, false, OffsetDateTime::now_utc())
            .await
            .unwrap();
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(h.a.as_uuid())
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(
        read.request.unwrap().requested_by_name.as_deref(),
        Some(name.as_str())
    );
    h.command(
        h.ops,
        h.org,
        id,
        C::Cancel {
            reason: "Retained device".into(),
        },
    )
    .await
    .unwrap();
    let read =
        h.p.read_ops_recovery(&h.runtime, h.org, false, OffsetDateTime::now_utc())
            .await
            .unwrap();
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(h.ops.as_uuid())
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(
        read.request.unwrap().cancelled_by_name.as_deref(),
        Some(name.as_str())
    );
    let second = h.approved().await;
    h.force_hold_elapse(second).await;
    h.vendor(h.a, second, C::Issue).await.unwrap();
    for org in [h.org, OrgId::platform()] {
        let actions: Vec<String> = sqlx::query_scalar("SELECT a.action FROM resource_changes c JOIN audit_events a ON a.id=c.audit_event_id WHERE c.org_id=$1 AND c.resource_type='ops_recovery' ORDER BY c.seq")
            .bind(org.as_uuid()).fetch_all(&h.owner).await.unwrap();
        assert_eq!(
            actions,
            vec![
                "platform.tenant.ops_recovery.open",
                "platform.tenant.ops_recovery.approve",
                "platform.tenant.ops_recovery.cancel",
                "platform.tenant.ops_recovery.open",
                "platform.tenant.ops_recovery.approve",
                "platform.tenant.ops_recovery.issue"
            ]
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_evidence_identifier(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    for text in [
        "900101-1234567",
        "９００１０１－１２３４５６７",
        "９０ ０１０１ - １２３ ４５６７",
        "901231‐1234567",
        "901231‑1234567",
        "901231‒1234567",
        "901231–1234567",
        "901231—1234567",
        "901231―1234567",
        "901231－1234567",
        "901231_1234567",
        "901231.1234567",
    ] {
        for name in [false, true] {
            let mut command = open();
            if let C::Open {
                authoriser_name,
                evidence_ref,
                ..
            } = &mut command
            {
                if name {
                    *authoriser_name = text.into();
                } else {
                    *evidence_ref = text.into();
                }
            }
            h.refusal(
                h.a,
                Uuid::new_v4(),
                command,
                "ops_recovery_evidence_identifier",
            )
            .await;
        }
    }
    assert_eq!(h.recovery_codes().await, 0);
}
