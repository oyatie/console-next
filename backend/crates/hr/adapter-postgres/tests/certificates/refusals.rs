// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use console_hr_adapter_postgres::certificates::CertificateListQuery;
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn foreign_employee_and_expired_exit_are_refused_without_register_writes(pool: PgPool) {
    let w = World::new(pool.clone()).await;
    let other = World::new(pool).await;
    w.configure().await;
    let mut foreign = w.issue_body();
    foreign.employee_id = other.employee;
    assert_eq!(
        w.hr.issue_certificate(w.actor.clone(), Some(Uuid::new_v4().to_string()), foreign)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2021-02-01' WHERE id=$1",
    )
    .bind(w.employee)
    .execute(&w.owner)
    .await
    .unwrap();
    let mut expired = w.issue_body();
    expired.kind = "CAREER".into();
    assert_eq!(
        w.hr.issue_certificate(w.actor.clone(), Some(Uuid::new_v4().to_string()), expired)
            .await
            .unwrap_err()
            .code,
        "certificate_retention_expired"
    );
    assert_eq!(w.count().await, 0);
    let reservations:i64=sqlx::query_scalar("SELECT count(*) FROM api_idempotency_keys WHERE org_id=$1 AND operation LIKE 'certificate.%'").bind(w.actor.org_id.as_uuid()).fetch_one(&w.owner).await.unwrap();
    assert_eq!(reservations, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_certificate_route_refuses_a_lower_grant_and_foreign_document(pool: PgPool) {
    let w = World::new(pool.clone()).await;
    let other = World::new(pool).await;
    w.configure().await;
    let first = w.issue(&Uuid::new_v4().to_string()).await;
    let id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    let lower = Principal::new(
        w.actor.user_id,
        w.actor.org_id,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    );
    assert_eq!(
        w.hr.issue_certificate(
            lower.clone(),
            Some(Uuid::new_v4().to_string()),
            w.issue_body()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.certificates(lower.clone(), CertificateListQuery::default())
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.certificate(lower.clone(), id).await.unwrap_err().code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.void_certificate(
            lower.clone(),
            id,
            Some(Uuid::new_v4().to_string()),
            World::reason()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.reissue_certificate(
            lower.clone(),
            id,
            Some(Uuid::new_v4().to_string()),
            World::reason()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.certificate_settings(lower.clone())
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.set_certificate_settings(lower, w.settings())
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    assert_eq!(
        other
            .hr
            .certificate(other.actor.clone(), id)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        other
            .hr
            .void_certificate(
                other.actor.clone(),
                id,
                Some(Uuid::new_v4().to_string()),
                World::reason()
            )
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        other
            .hr
            .reissue_certificate(
                other.actor.clone(),
                id,
                Some(Uuid::new_v4().to_string()),
                World::reason()
            )
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert!(
        other
            .hr
            .certificates(other.actor.clone(), CertificateListQuery::default())
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(w.count().await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn validation_and_missing_facts_do_not_take_a_number(pool: PgPool) {
    let w = World::new(pool).await;
    assert_eq!(
        w.hr.issue_certificate(
            w.actor.clone(),
            Some(Uuid::new_v4().to_string()),
            w.issue_body()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_settings_required"
    );
    let mut bad = w.settings();
    bad.width = 0;
    assert_eq!(
        w.hr.set_certificate_settings(w.actor.clone(), bad)
            .await
            .unwrap_err()
            .code,
        "certificate_invalid"
    );
    w.configure().await;
    assert_eq!(
        w.hr.set_certificate_settings(w.actor.clone(), w.settings())
            .await
            .unwrap_err()
            .code,
        "certificate_state_conflict"
    );
    for (kind, items, purpose, code) in [
        ("OTHER", vec!["period"], "제출용", "certificate_invalid"),
        ("EMPLOYMENT", vec![], "제출용", "certificate_invalid"),
        (
            "EMPLOYMENT",
            vec!["period", "period"],
            "제출용",
            "certificate_invalid",
        ),
        (
            "EMPLOYMENT",
            vec!["raw_row"],
            "제출용",
            "certificate_invalid",
        ),
        (
            "CAREER",
            vec!["birth"],
            "제출용",
            "certificate_facts_missing",
        ),
        ("EMPLOYMENT", vec!["period"], " ", "certificate_invalid"),
        ("EXIT", vec!["period"], "제출용", "certificate_ineligible"),
    ] {
        let mut b = w.issue_body();
        b.kind = kind.into();
        b.items = items.into_iter().map(str::to_owned).collect();
        b.purpose = purpose.into();
        assert_eq!(
            w.hr.issue_certificate(w.actor.clone(), Some(Uuid::new_v4().to_string()), b)
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    assert_eq!(w.count().await, 0);
    assert!(
        w.issue(&Uuid::new_v4().to_string()).await["certificate_no"]
            .as_str()
            .unwrap()
            .ends_with("000001")
    );
}
