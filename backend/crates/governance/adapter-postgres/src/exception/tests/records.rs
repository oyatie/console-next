//! BW-06 attestations, tenancy and tenant removal (helpers in `db.rs`).

use super::*;
use crate::exception::{AttestRequest, attest_conn};
use console_governance_domain::exception::{Attestation, AttestationDetails};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attestation_writes_both_rows_and_facts_only_go_that_way(owner: PgPool) {
    let (me, _) = seed(&owner, ORG_A).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let fact = RuleCode::InsuranceLossReported;
    let as_exception = request_exception_conn(
        &mut tx,
        &request(fact, me, &json!({}), &[], 0, Some(Uuid::new_v4())),
        &settings(),
    )
    .await;
    assert_eq!(
        code(as_exception.unwrap_err()),
        "exception_fact_needs_attestation"
    );

    let attestation = Attestation {
        fact,
        fact_date: day(2026, time::Month::October, 1),
        details: AttestationDetails {
            filer: Some("노무법인 대행".into()),
            receipt_numbers: vec![" ".into()],
            ..AttestationDetails::default()
        },
    };
    let mut req = AttestRequest {
        attestation: &attestation,
        subject_type: SubjectType::ExitCase,
        subject_id: Uuid::from_u128(9),
        reason_code: "FILED",
        note: None,
        attested_by: me,
        step_up_assertion_id: None,
    };
    let bare = attest_conn(&mut tx, &req, &settings()).await;
    assert_eq!(
        code(bare.unwrap_err()),
        "step_up_required",
        "MEDIUM fact closes a legal clock"
    );
    req.step_up_assertion_id = Some(Uuid::new_v4());
    let done = attest_conn(&mut tx, &req, &settings()).await.unwrap();
    assert!(done.review_flag, "no receipt number: review flag");
    let (filer, numbers): (String, Vec<String>) = sqlx::query_as(
        "SELECT filer, receipt_numbers FROM governed_exception_attestations WHERE id = $1",
    )
    .bind(done.attestation_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!((filer.as_str(), numbers.len()), ("노무법인 대행", 0));
    let stored = get_exception_conn(&mut tx, done.exception_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (stored.rule, stored.status),
        (fact, ExceptionStatus::Recorded)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rows_are_tenant_scoped_and_never_deleted_at_runtime(owner: PgPool) {
    let (me, _) = seed(&owner, ORG_A).await;
    seed(&owner, ORG_B).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let payload = json!({});
    let req = request(RuleCode::SiblingNameDuplicate, me, &payload, &[], 0, None);
    let id = request_exception_conn(&mut tx, &req, &settings())
        .await
        .unwrap()
        .id;
    tx.commit().await.unwrap();

    let mut b = org_tx(&rt, ORG_B).await;
    assert_eq!(get_exception_conn(&mut b, id).await.unwrap(), None);
    let filter = crate::exception::ExceptionFilter::default();
    let listed = crate::exception::list_exceptions_conn(&mut b, filter, 50)
        .await
        .unwrap();
    assert!(listed.is_empty());
    let hidden = consume_exception_conn(&mut b, id, &write(req.rule, &payload, &[])).await;
    assert_eq!(code(hidden.unwrap_err()), "exception_not_found");
    drop(b);

    // console_rt cannot delete, even with the force-removal GUC it can set itself.
    let mut a = org_tx(&rt, ORG_A).await;
    sqlx::query("SET LOCAL app.platform_force_remove_org = 'on'")
        .execute(&mut *a)
        .await
        .unwrap();
    let denied = sqlx::query("DELETE FROM governed_exceptions WHERE id = $1")
        .bind(id)
        .execute(&mut *a)
        .await
        .unwrap_err();
    assert_eq!(
        denied.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    drop(a);
    // The owner without the GUC hits the append-only trigger.
    let blocked = sqlx::query("DELETE FROM governed_exceptions WHERE id = $1")
        .bind(id)
        .execute(&owner)
        .await
        .unwrap_err();
    assert!(
        blocked
            .to_string()
            .contains("append-only governance record"),
        "{blocked}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn force_removal_clears_an_archived_tenants_exceptions(owner: PgPool) {
    let (me, _) = seed(&owner, ORG_A).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let payload = json!({});
    let req = request(RuleCode::SiblingNameDuplicate, me, &payload, &[], 0, None);
    request_exception_conn(&mut tx, &req, &settings())
        .await
        .unwrap();
    let attestation = Attestation {
        fact: RuleCode::ResignationReceived,
        fact_date: day(2026, time::Month::October, 1),
        details: AttestationDetails {
            evidence_ref: Some("doc-1".into()),
            ..AttestationDetails::default()
        },
    };
    let att = AttestRequest {
        attestation: &attestation,
        subject_type: SubjectType::ExitCase,
        subject_id: Uuid::from_u128(9),
        reason_code: "RECEIVED",
        note: None,
        attested_by: me,
        step_up_assertion_id: None,
    };
    attest_conn(&mut tx, &att, &settings()).await.unwrap();
    tx.commit().await.unwrap();

    sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1")
        .bind(ORG_A)
        .execute(&owner)
        .await
        .unwrap();
    let result: String = sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
        .bind(ORG_A)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(result, "removed");
    let left: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM governed_exceptions WHERE org_id = $1) \
              + (SELECT COUNT(*) FROM governed_exception_attestations WHERE org_id = $1)",
    )
    .bind(ORG_A)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(left, 0);
}
