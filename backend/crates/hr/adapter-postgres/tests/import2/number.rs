//! 사번 변경 keeps the old number as an alias that still finds the person;
//! a renumbering previews old → new, applies as one job and undoes in SETUP.

use console_hr_adapter_postgres::employee_number::change::EmployeeNumberChangeRequest;
use console_hr_adapter_postgres::employee_number::renumber::RenumberRequest;
use console_hr_adapter_postgres::employee_number::renumber_apply::RenumberApplyRequest;
use console_hr_adapter_postgres::employee_number::rules::NumberRuleRequest;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::harness::{Importer, decisions, importer, table};

async fn version(i: &Importer, id: Uuid) -> String {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    at.format(&Rfc3339).unwrap()
}

fn change(number: &str, expected: String) -> EmployeeNumberChangeRequest {
    EmployeeNumberChangeRequest {
        new_number: number.into(),
        effective_date: console_hr_adapter_postgres::clock::today_kst().to_string(),
        reason_code: "NUMBERING_SCHEME_CHANGE".into(),
        note: None,
        expected_updated_at: expected,
    }
}

fn scheme(prefix: &str) -> RenumberRequest {
    RenumberRequest {
        scope_kind: "TENANT".into(),
        scope_id: None,
        prefix: prefix.into(),
        width: 3,
        effective_date: console_hr_adapter_postgres::clock::today_kst().to_string(),
        reason_code: "NUMBERING_SCHEME_CHANGE".into(),
        note: None,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_changed_number_stays_an_alias_and_a_renumbering_undoes_in_setup(pool: PgPool) {
    let i = importer(pool.clone()).await;
    let header: &[&str] = &["사번", "성명", "입사일"];
    i.load(
        "a.xlsx",
        &[table(
            "명부",
            0,
            &[
                header,
                &["1001", "김가", "2024-01-02"],
                &["1002", "이나", "2024-02-03"],
            ],
        )],
        decisions(),
    )
    .await;
    let (kim, _, _) = i.person("김가").await;
    let (lee, _, _) = i.person("이나").await;
    let hr = &i.f.hr;
    let p = || i.f.principal.clone();

    hr.change_employee_number(p(), kim, change("S-1", version(&i, kim).await))
        .await
        .unwrap();
    let found = hr
        .find_by_employee_number(p(), "1001".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!((found.employee_id, found.matched_by), (kim, "alias"));
    assert_eq!(hr.employee_number_history(p(), kim).await.unwrap().len(), 1);
    for taken in ["S-1", "1001"] {
        let refused = hr
            .change_employee_number(p(), lee, change(taken, version(&i, lee).await))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "employee_number_taken", "{taken}");
    }
    // A later file with the old number still finds the person.
    let run = i
        .preview(
            "b.xlsx",
            &[table("명부", 0, &[header, &["1001", "김가", "2024-01-02"]])],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(
        (plan.rows[0].matched_by, plan.rows[0].employee_id),
        (Some("alias"), Some(kim))
    );

    let rule = hr
        .set_employee_number_rule(
            p(),
            NumberRuleRequest {
                scope_kind: "TENANT".into(),
                scope_id: None,
                prefix: "T-".into(),
                width: 3,
            },
        )
        .await
        .unwrap();
    assert_eq!(rule.next_number, "T-001");

    let preview = hr.preview_renumber(p(), scheme("T-")).await.unwrap();
    assert_eq!((preview.lines.len(), preview.conflicts), (2, 0));
    assert_eq!(preview.lines[0].from.as_deref(), Some("S-1"));
    let stale = hr
        .apply_renumber(
            p(),
            RenumberApplyRequest {
                request: scheme("T-"),
                preview_digest: "0".repeat(64),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code, "renumber_preview_stale");
    let done = hr
        .apply_renumber(
            p(),
            RenumberApplyRequest {
                request: scheme("T-"),
                preview_digest: preview.preview_digest,
            },
        )
        .await
        .unwrap();
    assert_eq!(i.person("김가").await.1.as_deref(), Some("T-001"));
    assert_eq!(i.person("이나").await.1.as_deref(), Some("T-002"));
    hr.undo_renumber(p(), done.batch_id).await.unwrap();
    assert_eq!(i.person("김가").await.1.as_deref(), Some("S-1"));
    assert_eq!(i.person("이나").await.1.as_deref(), Some("1002"));
    assert_eq!(
        hr.undo_renumber(p(), done.batch_id).await.unwrap_err().code,
        "renumber_already_undone"
    );

    // After 운영 시작 there is no bulk renumbering (or its undo) yet.
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
        .bind(i.org())
        .execute(&pool)
        .await
        .unwrap();
    let preview = hr.preview_renumber(p(), scheme("U-")).await.unwrap();
    let refused = hr
        .apply_renumber(
            p(),
            RenumberApplyRequest {
                request: scheme("U-"),
                preview_digest: preview.preview_digest,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "phase_not_setup");
    assert_eq!(
        hr.undo_renumber(p(), done.batch_id).await.unwrap_err().code,
        "phase_not_setup"
    );
}

/// regression (records-02, r2): once the auto-issued E-000001 was retired by
/// a 사번 변경, every registration with 사번 empty was issued E-000001 again
/// and refused 409 `employee_number_taken`. The next number skips every 사번
/// ever used, aliases included.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn auto_numbering_skips_a_retired_alias(pool: PgPool) {
    let i = importer(pool).await;
    let first = i.f.create(i.f.body("rec02-a", "REGULAR")).await.unwrap();
    let kim = first.employee.id;
    assert_eq!(first.employee.employee_number.as_deref(), Some("E-000001"));
    i.f.hr
        .change_employee_number(
            i.f.principal.clone(),
            kim,
            change("HB-1001", version(&i, kim).await),
        )
        .await
        .unwrap();
    let mut body = i.f.body("rec02-b", "REGULAR");
    body.name = "이등록".into();
    body.phone = "010-2222-3333".into();
    let second = i.f.create(body).await.unwrap();
    assert_eq!(second.employee.employee_number.as_deref(), Some("E-000002"));
}
