//! A company column is evidence to review, never an entity name to create.
use crate::harness::{importer, table};
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::plan::Decisions;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "../../../../entity/adapter-postgres/tests/common/mod.rs"]
mod entity_fixture;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn imported_company_and_representatives_remain_source_cells_in_confirmation_queue(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let sheets = [table(
        "인사 명부",
        2,
        &[
            &[
                "회사",
                "상호",
                "대표자",
                "성명",
                "사번",
                "입사일",
                "고용형태",
            ],
            &[
                "GANATECH",
                "주식회사 가나테크",
                "김예시,박예시",
                "김직원",
                "1001",
                "2026-01-01",
                "정규직",
            ],
            &[
                "김예시,박예시",
                "",
                "김예시,박예시",
                "이직원",
                "1002",
                "2026-01-01",
                "정규직",
            ],
        ],
    )];
    let preview = i
        .preview(
            "company-labels.xlsx",
            &sheets,
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap();
    let dry = i.dry_run(preview.run_id, Decisions::default()).await;
    let items: Vec<_> = dry
        .review
        .items
        .iter()
        .filter(|r| r.reason == "company_unconfirmed")
        .collect();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].cell.as_deref(), Some("A4"));
    assert_eq!(items[0].source_column.as_deref(), Some("회사"));
    assert_eq!(items[1].value.as_deref(), Some("김예시,박예시"));
    assert!(items.iter().all(|r| r.candidates.is_empty() && !r.blocking));
    i.apply(preview.run_id, &dry.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM legal_entities WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        2
    );
    assert_eq!(i.count("SELECT count(*) FROM employment_assignments WHERE org_id = $1 AND legal_entity_id IS NOT NULL").await, 0);
    assert_eq!(i.count("SELECT count(*) FROM employees WHERE org_id = $1 AND company IN ('GANATECH','김예시,박예시')").await, 0);
    let rows =
        i.f.hr
            .import_reconcile_rows(
                i.f.principal.clone(),
                preview.run_id,
                console_hr_adapter_postgres::import::reconcile::ReconcileRowsQuery::default(),
            )
            .await
            .unwrap()
            .items;
    let source = rows
        .iter()
        .find(|r| r.name.as_deref() == Some("이직원"))
        .unwrap();
    let evidence = source.company_confirmation.as_ref().unwrap();
    assert_eq!(evidence.value, "김예시,박예시");
    assert_eq!(evidence.cell.as_deref(), Some("A5"));
    assert_eq!(evidence.source_column.as_deref(), Some("회사"));
    assert!(evidence.confirmed_employer.is_none());
    let refused = i
        .f
        .hr
        .set_import_reconcile_check(
            i.f.principal.clone(),
            preview.run_id,
            source.source_key.clone(),
            serde_json::from_value(serde_json::json!({"state":"CONFIRMED", "expected_version":0}))
                .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.status.as_u16(), 422);
    assert_eq!(refused.code, "entity_certificate_unconfirmed");
    assert_eq!(
        i.count("SELECT count(*) FROM import_reconcile_checks WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(i.count("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'data_import.reconcile_check'").await, 0);
    let actor = console_entity_application::Actor {
        org: i.f.principal.org_id,
        user: i.f.principal.user_id,
        trace: console_kernel_core::TraceContext::generate(),
        command_id: None,
        scope: console_entity_application::EntityScope::Tenant,
    };
    let store = console_entity_adapter_postgres::PgEntityStore::new(i.f.rt.clone());
    let (entity, workplaces) = entity_fixture::two_workplaces(&store, &actor).await;
    store
        .bind_assignment(
            &entity_fixture::cmd(&actor),
            console_entity_application::BindAssignment {
                employee_id: source.employee_id.unwrap(),
                legal_entity_id: Some(entity),
                workplace_id: Some(workplaces[1].0),
                valid_from: Some("2026-01-01".into()),
            },
        )
        .await
        .unwrap();
    let confirmed = i
        .f
        .hr
        .set_import_reconcile_check(
            i.f.principal.clone(),
            preview.run_id,
            source.source_key.clone(),
            serde_json::from_value(serde_json::json!({"state":"CONFIRMED", "expected_version":0}))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(confirmed.state, "CONFIRMED");
    assert_eq!(
        confirmed
            .company_confirmation
            .unwrap()
            .confirmed_employer
            .as_deref(),
        Some("주식회사 가나")
    );
    assert_eq!(i.count("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'data_import.reconcile_check'").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_certificate_unconfirmed_refuses_a_guessed_employer_without_import_side_effects(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let sheets = [table(
        "명부",
        0,
        &[
            &["회사", "성명", "사번", "입사일", "고용형태"],
            &["김예시,박예시", "김직원", "1001", "2026-01-01", "정규직"],
        ],
    )];
    let run = i
        .preview(
            "unconfirmed.xlsx",
            &sheets,
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, Decisions::default()).await;
    let item = dry
        .review
        .items
        .iter()
        .find(|r| r.reason == "company_unconfirmed")
        .unwrap();
    let mut decisions = Decisions::default();
    decisions.company_map.insert(
        item.resolution.as_ref().unwrap().key.clone(),
        Some(Uuid::new_v4()),
    );
    let err = i.try_dry_run(run, decisions).await.unwrap_err();
    assert_eq!(err.code, "entity_certificate_unconfirmed");
    assert_eq!(err.status.as_u16(), 422);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(
        i.count("SELECT count(*) FROM legal_entities WHERE org_id = $1")
            .await,
        0
    );
}
