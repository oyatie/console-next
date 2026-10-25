// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The legal deadline, rather than the event date, controls pre-console exclusion.
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use console_hr_adapter_postgres::{
    cases::TemplatePreviewQuery, clock::today_kst, statutory::FilingQuery,
};
use sqlx::PgPool;
use time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_excludes_only_deadlines_before_today(pool: PgPool) {
    assert_boundary(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operating_keeps_deadlines_on_and_after_go_live(pool: PgPool) {
    assert_boundary(pool, true).await;
}

async fn assert_boundary(pool: PgPool, operating: bool) {
    let f = fixture::fixture(pool.clone()).await;
    let on = today_kst() - Duration::days(1);
    if operating {
        sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
                .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    }
    for (value, expected_days) in [(1, -1), (2, 0), (3, 1), (500, 498)] {
        sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{deadline,value}',to_jsonb($1::int)) WHERE code='ins.deadline.acquire.nhis'")
                .bind(value).execute(&pool).await.unwrap();
        let mut body = f.body(&format!("boundary-{operating}-{value}"), "REGULAR");
        body.hire_date = Some(on.to_string());
        let employee = f.create(body).await.unwrap().employee_id();
        let case =
            f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
                .await
                .unwrap()
                .remove(0);
        let item = case
            .items
            .iter()
            .find(|item| item.insurer.as_deref() == Some("NHIS"))
            .unwrap();
        let preview =
            f.hr.lifecycle_template_preview_for(
                f.principal.clone(),
                "ONBOARD".into(),
                TemplatePreviewQuery {
                    effective_date: Some(on),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let row = preview
            .iter()
            .find(|item| item.insurer.as_deref() == Some("NHIS"))
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let register =
            console_compliance_adapter_postgres::statutory::load_statutory_register(&mut conn)
                .await
                .unwrap();
        let filings =
            f.hr.insurance_filings(
                f.principal.clone(),
                FilingQuery {
                    event_id: case.trigger_id,
                    insurer: Some("NHIS".into()),
                    kind: Some("ACQUIRE".into()),
                    ..Default::default()
                },
                register,
            )
            .await
            .unwrap();
        if expected_days < 0 {
            assert_eq!(item.status_code.as_deref(), Some("PRE_CONSOLE"));
            assert_eq!(row.due_disposition.as_deref(), Some("PRE_CONSOLE"));
            assert!(filings.items.is_empty());
            assert!(item.filing_obligation_id.is_none());
        } else {
            assert_ne!(item.status_code.as_deref(), Some("PRE_CONSOLE"));
            assert!(matches!(item.status.as_str(), "OPEN" | "BLOCKED"));
            assert_eq!(item.due_in_days, Some(expected_days));
            assert_eq!(row.due_in_days, item.due_in_days);
            assert_eq!(filings.items.len(), 1);
            assert_eq!(filings.items[0].due_in_days, Some(expected_days));
            assert_eq!(
                filings.items[0].filing_obligation_id,
                item.filing_obligation_id
            );
        }
    }
}
