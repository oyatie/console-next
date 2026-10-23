// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use console_hr_adapter_postgres::directory::read_filters::EmployeeListQuery;
use console_hr_adapter_postgres::person_binding::ReviewQuery;
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn branch_hr_sees_employee_and_account_reviews_without_foreign_evidence(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let a = f
        .create(f.body("review-a", "REGULAR"))
        .await
        .unwrap()
        .employee;
    let mut other = f.body("review-b", "REGULAR");
    other.phone = "010-9999-0001".into();
    let b = f.create(other).await.unwrap().employee;
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Account') RETURNING id",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(a.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id=CASE WHEN id=$1 THEN $2 ELSE NULL END,identity_review_required=false WHERE id=ANY($3)")
        .bind(a.id).bind(f.branch).bind(vec![a.id,b.id]).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    // Both subject kinds may have reviews independently of the legacy identity flag.
    for (kind, id) in [("EMPLOYEE", a.id), ("EMPLOYEE", b.id), ("ACCOUNT", account)] {
        sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,$2,$3,'NUMBER_BIRTH_AMBIGUOUS',$4) ON CONFLICT DO NOTHING")
            .bind(f.principal.org_id.as_uuid()).bind(kind).bind(id)
            .bind(json!({"candidates":[{"employee_id":a.id},{"employee_id":b.id}]}))
            .execute(&pool).await.unwrap();
    }
    let unlinked: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Unlinked') RETURNING id",
    )
    .bind(f.principal.org_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'EMPLOYEE_LINK_MISSING',$3)")
        .bind(f.principal.org_id.as_uuid()).bind(unlinked)
        .bind(json!({"candidates":[{"employee_id":a.id},{"employee_id":b.id}]})).execute(&pool).await.unwrap();
    let principal = Principal::new(
        f.principal.user_id,
        f.principal.org_id,
        BTreeSet::from([Role::Admin]),
        BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(f.branch)])),
    );
    let page =
        f.hr.person_binding_reviews(principal.clone(), ReviewQuery::default())
            .await
            .unwrap();
    assert_eq!(page.total, 3);
    for review in &page.items {
        assert!(
            review.subject_id == a.id
                || review.subject_id == account
                || review.subject_id == unlinked
        );
        let candidates = review.evidence["candidates"].as_array().unwrap();
        assert_eq!(
            candidates.len(),
            1,
            "out-of-scope candidate identifiers and dates are removed"
        );
        assert_eq!(candidates[0]["employee_id"], a.id.to_string());
        assert_eq!(candidates[0]["name"], a.name);
        assert_eq!(candidates[0]["employee_number"], json!(a.employee_number));
    }
    let outside =
        f.hr.person_binding_reviews(
            principal.clone(),
            ReviewQuery {
                subject_id: Some(b.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(outside.total, 0);
    assert!(outside.items.is_empty());
    for verdict in ["DIFFERENT", "SAME"] {
        let refused =
            f.hr.resolve_identity(
                principal.clone(),
                &console_platform_test_support::soft_passkey::passkey_service(),
                a.id,
                serde_json::from_value(
                    json!({"verdict":verdict,"keep_employee_id":b.id,"reason_code":"VERIFIED"}),
                )
                .unwrap(),
                console_hr_adapter_postgres::corrections::SecondPersonContext {
                    other_eligible_holders: 1,
                    routed: true,
                    sole_holder_refuse: false,
                },
            )
            .await
            .unwrap_err();
        assert_eq!((refused.status.as_u16(), refused.code), (403, "forbidden"));
    }
    let done =
        f.hr.resolve_identity(
            f.principal.clone(),
            &console_platform_test_support::soft_passkey::passkey_service(),
            a.id,
            serde_json::from_value(
                json!({"verdict":"DIFFERENT","reason_code":"VERIFIED_DIFFERENT"}),
            )
            .unwrap(),
            console_hr_adapter_postgres::corrections::SecondPersonContext {
                other_eligible_holders: 1,
                routed: true,
                sole_holder_refuse: false,
            },
        )
        .await
        .unwrap();
    assert!(!done.review_required);
    assert_eq!(
        f.hr.person_binding_reviews(
            principal.clone(),
            ReviewQuery {
                subject_id: Some(a.id),
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .total,
        0
    );
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(b.id)
        .bind(unlinked)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.hr.person_binding_reviews(
            principal,
            ReviewQuery {
                subject_id: Some(unlinked),
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .total,
        0
    );
    let mut member = f.principal.clone();
    member.roles = BTreeSet::from([Role::Member]);
    assert_eq!(
        f.hr.person_binding_reviews(member, ReviewQuery::default())
            .await
            .unwrap_err()
            .status
            .as_u16(),
        403
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn roster_identity_counts_and_filters_include_open_reviews_until_decided(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let a = f
        .create(f.body("roster-a", "REGULAR"))
        .await
        .unwrap()
        .employee;
    let b = f
        .create(f.body("roster-b", "REGULAR"))
        .await
        .unwrap()
        .employee;
    sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'EMPLOYEE',$2,'NUMBER_BIRTH_AMBIGUOUS',$3)")
        .bind(f.principal.org_id.as_uuid()).bind(a.id)
        .bind(json!({"candidates":[{"employee_id":b.id}]})).execute(&pool).await.unwrap();
    for decided in [false, true] {
        let facets =
            f.hr.employee_facets(f.principal.clone(), EmployeeListQuery::default())
                .await
                .unwrap();
        assert_eq!(facets.review.identity_review_required, i64::from(!decided));
        for required in [false, true] {
            let list =
                f.hr.list_employees(
                    f.principal.clone(),
                    EmployeeListQuery {
                        identity_review_required: Some(required),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(list.items.iter().any(|e| e.id == a.id), required != decided);
            assert_eq!(list.items.iter().any(|e| e.id == b.id), !required);
            for row in &list.items {
                assert_eq!(
                    row.identity_review_required, required,
                    "the roster chip must agree with its review filter"
                );
            }
        }
        if !decided {
            f.hr.resolve_identity(
                f.principal.clone(),
                &console_platform_test_support::soft_passkey::passkey_service(),
                a.id,
                serde_json::from_value(
                    json!({"verdict":"DIFFERENT","reason_code":"VERIFIED_DIFFERENT"}),
                )
                .unwrap(),
                console_hr_adapter_postgres::corrections::SecondPersonContext {
                    other_eligible_holders: 1,
                    routed: true,
                    sole_holder_refuse: false,
                },
            )
            .await
            .unwrap();
        }
    }
}
