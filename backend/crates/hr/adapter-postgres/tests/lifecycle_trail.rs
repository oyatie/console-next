// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Registration and its lifecycle trail share one transaction and replay key.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::directory::create_core::create_employee_core;
use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_opens_one_hire_case_and_replay_keeps_its_items(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let body = || {
        let mut body = f.body("lifecycle-hire-replay", "REGULAR");
        body.hire_date = Some(today_kst().to_string());
        body
    };
    let employee = f.create(body()).await.unwrap().employee_id();
    let before: (i64, i64) = sqlx::query_as(
        "SELECT count(DISTINCT c.id), count(i.id) FROM lifecycle_cases c \
         LEFT JOIN lifecycle_case_items i ON i.org_id = c.org_id AND i.case_id = c.id \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.kind = 'HIRE'",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before.0, 1, "the hire event must open its case");
    assert!(before.1 > 0, "the hire case must carry its template items");
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    for key in [
        "enum.checklistItem.BIRTH_DATE_RECORDED",
        "enum.checklistItem.ID_REGISTERED",
        "enum.checklistItem.PAY_RECORDED",
        "enum.checklistItem.CONTRACT_RECORDED",
    ] {
        assert!(
            case.items
                .iter()
                .any(|item| item.label_key.as_deref() == Some(key)),
            "hire checklist fact missing: {key}"
        );
    }
    let preview =
        f.hr.lifecycle_template_preview(f.principal.clone(), "HIRE".to_owned())
            .await
            .unwrap();
    assert_eq!(
        preview
            .iter()
            .map(|i| &i.item_key)
            .collect::<std::collections::BTreeSet<_>>(),
        case.items.iter().map(|i| &i.item_key).collect()
    );
    let filing = preview.iter().find(|i| i.kind == "FIL").unwrap();
    let metadata = serde_json::to_value(filing).unwrap();
    assert_eq!(metadata["legal_review_required"], true);
    assert!(metadata["opens_rule_ref"].is_string());
    assert!(metadata["filing_kind"].is_string());
    assert!(metadata["insurer"].is_string());

    assert_eq!(f.create(body()).await.unwrap().employee_id(), employee);
    let after: (i64, i64) = sqlx::query_as(
        "SELECT count(DISTINCT c.id), count(i.id) FROM lifecycle_cases c \
         LEFT JOIN lifecycle_case_items i ON i.org_id = c.org_id AND i.case_id = c.id \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.kind = 'HIRE'",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, before, "replay must preserve one case and its items");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_registration_keeps_trail_items_pending_until_the_event(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut body = f.body("lifecycle-future-hire", "REGULAR");
    body.hire_date = Some((today_kst() + Duration::days(1)).to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let (cases, items, pending): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(DISTINCT c.id), count(i.id), \
                count(i.id) FILTER (WHERE i.status = 'PENDING_TRIGGER') \
         FROM lifecycle_cases c LEFT JOIN lifecycle_case_items i \
           ON i.org_id = c.org_id AND i.case_id = c.id \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.kind = 'HIRE'",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cases, 1, "a scheduled hire must already carry its case");
    assert!(items > 0);
    assert_eq!(pending, items, "future event items must not be actionable");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rolled_back_registration_leaves_no_event_case_or_items(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut body = f.body("lifecycle-rollback", "REGULAR");
    body.hire_date = Some(today_kst().to_string());
    let request = normalize_create_employee_request(body).unwrap();
    let hash = serde_json::to_string(&request).unwrap();
    let employee = Uuid::new_v4();
    let org = *f.principal.org_id.as_uuid();
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    create_employee_core(
        &mut tx,
        org,
        f.principal.user_id,
        &request,
        &console_hr_adapter_postgres::digest::sha256_hex(hash.as_bytes()),
        employee,
    )
    .await
    .unwrap();
    let opened_cases: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lifecycle_cases WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    let (events, cases, items): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
           (SELECT count(*) FROM employee_lifecycle_events WHERE org_id = $1 AND employee_id = $2), \
           (SELECT count(*) FROM lifecycle_cases WHERE org_id = $1 AND employee_id = $2), \
           (SELECT count(*) FROM lifecycle_case_items WHERE org_id = $1)",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((events, cases, items), (0, 0, 0));
    assert_eq!(opened_cases, 1, "the case must exist before rollback");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_changes_recompute_the_same_case_and_filing_window(pool: PgPool) {
    use console_hr_adapter_postgres::statutory::FilingQuery;

    let f = fixture::fixture(pool.clone()).await;
    let on = today_kst();
    let mut body = f.body("lifecycle-register-window", "REGULAR");
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
        .find(|item| item.due_rule_ref.as_deref() == Some("ins.deadline.acquire.nhis"))
        .unwrap();
    assert!(item.opens_on.is_some());
    assert!(item.due_date.is_some());
    let id = item
        .filing_obligation_id
        .expect("case filing must have its obligation identity");
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(jsonb_set(filing_rule,'{opens_offset}',to_jsonb((filing_rule->>'opens_offset')::int+1)), \
        '{deadline,value}',to_jsonb((filing_rule#>>'{deadline,value}')::int+1)) \
        WHERE code='ins.deadline.acquire.nhis' AND effective_from<=$1 AND (effective_to_exclusive IS NULL OR $1<effective_to_exclusive)")
        .bind(on).execute(&pool).await.unwrap();
    let updated =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let changed = updated
        .items
        .iter()
        .find(|changed| changed.id == item.id)
        .unwrap();
    assert_ne!(
        changed.opens_on, item.opens_on,
        "register opening changes must be reflected without a new event"
    );
    assert_ne!(
        changed.due_date, item.due_date,
        "register deadline changes must be reflected without a new event"
    );
    assert_eq!(changed.filing_obligation_id, Some(id));
    let mut conn = pool.acquire().await.unwrap();
    let register =
        console_compliance_adapter_postgres::statutory::load_statutory_register(&mut conn)
            .await
            .unwrap();
    drop(conn);
    let filings =
        f.hr.insurance_filings(
            f.principal.clone(),
            FilingQuery {
                event_id: case.trigger_id,
                insurer: Some("NHIS".to_owned()),
                kind: Some("ACQUIRE".to_owned()),
                ..Default::default()
            },
            register,
        )
        .await
        .unwrap();
    let filing = filings
        .items
        .iter()
        .find(|filing| filing.employee_id == employee)
        .unwrap();
    assert_eq!(filing.filing_obligation_id, Some(id));
    assert_eq!(filing.opens_on, changed.opens_on);
    assert_eq!(filing.due_date, changed.due_date);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pre_console_hire_history_is_preserved_without_overdue_filings_by_entry_path(pool: PgPool) {
    use console_hr_adapter_postgres::statutory::FilingQuery;

    let f = fixture::fixture(pool.clone()).await;
    let org = *f.principal.org_id.as_uuid();
    // rls-arming: ok test fixture records the tenant's actual 운영 시작 as owner.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(org).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    let hired_on = (today_kst() - Duration::days(90)).to_string();
    let mut body = f.body("lifecycle-pre-console", "REGULAR");
    body.hire_date = Some(hired_on.clone());
    let registered = f.create(body).await.unwrap().employee_id();
    let cases =
        f.hr.employee_lifecycle_cases(f.principal.clone(), registered)
            .await
            .unwrap();
    assert_eq!(cases.len(), 1);
    let statutory: Vec<_> = cases[0]
        .items
        .iter()
        .filter(|item| item.kind == "FIL")
        .collect();
    assert!(!statutory.is_empty());
    assert!(statutory.iter().all(|item| item.status == "NOT_APPLICABLE"
        && item.status_code.as_deref() == Some("PRE_CONSOLE")
        && item.filing_obligation_id.is_none()));
    // An imported historical row has no ONBOARD event; it must not gain synthetic overdue work.
    let imported: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,hire_date) \
        VALUES ($1,'Co','이관 직원','legacy.xlsx','명부',1,$2,$3) RETURNING id")
        .bind(org).bind(Uuid::new_v4().to_string()).bind(hired_on).fetch_one(&pool).await.unwrap();
    assert!(
        f.hr.employee_lifecycle_cases(f.principal.clone(), imported)
            .await
            .unwrap()
            .is_empty()
    );
    let mut conn = pool.acquire().await.unwrap();
    let register =
        console_compliance_adapter_postgres::statutory::load_statutory_register(&mut conn)
            .await
            .unwrap();
    drop(conn);
    let filings =
        f.hr.insurance_filings(f.principal.clone(), FilingQuery::default(), register)
            .await
            .unwrap();
    assert!(filings.items.is_empty());
    assert_eq!(filings.pending, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn starting_operations_preserves_pre_console_setup_history(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut body = f.body("setup-history-before-go-live", "REGULAR");
    body.hire_date = Some((today_kst() - Duration::days(90)).to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid())
        .execute(&pool).await.unwrap();
    let cases =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap();
    let filings: Vec<_> = cases[0]
        .items
        .iter()
        .filter(|item| item.kind == "FIL")
        .collect();
    assert!(!filings.is_empty());
    assert!(filings.iter().all(|item| item.status == "NOT_APPLICABLE"
        && item.status_code.as_deref() == Some("PRE_CONSOLE")));
}
