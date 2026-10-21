//! BE-MIG W12 on the real preview: a roster without a pay period, its
//! footer row, a remembered sheet skip, and the 0300 guard behind the period.

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use sqlx::PgPool;

use crate::harness::{decisions, importer, map, table};

const HEADER: &[&str] = &["사번", "성명", "입사일", "고용형태", "부서", "연락처"];

/// regression (W12): a roster needed a pay period; the totals row became a
/// person; a skipped sheet had to be skipped again.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_roster_without_period_footer_or_remembered_sheet(pool: PgPool) {
    let i = importer(pool).await;
    let roster = table(
        "명부",
        0,
        &[
            HEADER,
            &["E-1", "김일", "2024-03-04", "정규직", "", ""],
            &["합계", "1명", "", "", "", ""],
        ],
    );
    let notes = table("메모", 0, &[&["성명"], &["김메모"]]);
    let skip = WorkbookMappingRequest {
        sheets: map(&[(
            "메모",
            SheetMappingRequest {
                skip: Some(true),
                ..SheetMappingRequest::default()
            },
        )]),
    };
    let first = i
        .preview_for("a.xlsx", &[roster.clone(), notes.clone()], &skip, None)
        .await
        .unwrap();
    let period: (Option<time::Date>, Option<time::Date>) = sqlx::query_as(
        "SELECT pay_period_start, pay_period_end FROM data_import_runs WHERE id = $1",
    )
    .bind(first.run_id)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(period, (None, None));
    assert_eq!(first.candidate_rows, 1, "the 합계 row is not a person");
    let plan = i.dry_run(first.run_id, decisions()).await;
    assert!(
        plan.review
            .items
            .iter()
            .any(|item| item.reason == "summary_row_skipped" && !item.blocking)
    );

    let second = i
        .preview_for(
            "b.xlsx",
            &[roster, notes],
            &WorkbookMappingRequest::default(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(second.sheets[1]["status"], "skipped");
    assert_eq!(second.sheets[1]["source"], "remembered");
    assert_eq!(second.candidate_rows, 1);
}

/// The 0300 guard behind W12: only an employee roster may carry no period;
/// an attendance run without one, or half a period, is still refused.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_an_employee_roster_may_omit_the_pay_period(pool: PgPool) {
    let i = importer(pool).await;
    let insert = |kind: &'static str, start: Option<&'static str>, end: Option<&'static str>| {
        sqlx::query(
            "INSERT INTO data_import_runs (id, org_id, entity_type, status, source_filename, \
               source_format, source_sha256, pay_period_start, pay_period_end) \
             VALUES (gen_random_uuid(), $1, $2, 'PREVIEWED', 'f', 'xlsx', repeat('a', 64), \
               $3::DATE, $4::DATE)",
        )
        .bind(i.org())
        .bind(kind)
        .bind(start)
        .bind(end)
        .execute(&i.owner)
    };
    insert("employee_hr", None, None).await.unwrap();
    let refused = insert("attendance_direct", None, None).await.unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("data_import_runs_pay_period_required"),
        "{refused}"
    );
    let half = insert("employee_hr", Some("2026-10-01"), None)
        .await
        .unwrap_err();
    assert!(
        half.to_string()
            .contains("data_import_runs_pay_period_both"),
        "{half}"
    );
}

/// The queue transaction settles the HTTP command; inline driving owns a fresh job context.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inline_driver_leaves_the_queued_http_outcome_immutable(pool: PgPool) {
    use console_hr_adapter_postgres::import::apply_drive::Started;
    use console_hr_adapter_postgres::import::types::EmployeeImportApplyRequest;
    use console_kernel_core::{AuditCommandContext, AuditSource};
    use console_platform_db::{command_context, command_outcomes};
    use uuid::Uuid;

    let i = importer(pool).await;
    let (run, digest) = crate::mig_job::staged(&i, 2).await;
    let org = i.f.principal.org_id;
    let actor = i.f.principal.user_id;
    let mut context = AuditCommandContext::for_actor(Some(actor));
    context.org_id = Some(org);
    context.source = AuditSource::Form;
    context.scope_ids = vec![*org.as_uuid()];
    let reservation = command_context::scope(
        context.clone(),
        command_outcomes::reserve(
            &i.f.rt,
            org,
            actor,
            Uuid::new_v4().to_string(),
            format!("POST /api/v1/employee-import-runs/{run}/apply"),
            digest.as_bytes().to_vec(),
            serde_json::json!({"masked": true}),
        ),
    )
    .await
    .unwrap();
    let command_outcomes::Reservation::Fresh(id) = reservation else {
        panic!("a new HTTP command must reserve a fresh outcome: {reservation:?}");
    };
    context.command_id = Some(id);
    command_context::scope(context, async {
        let queued =
            i.f.hr
                .start_apply(
                    i.f.principal.clone(),
                    run,
                    EmployeeImportApplyRequest {
                        dry_run_digest: digest,
                    },
                )
                .await
                .unwrap();
        assert!(matches!(queued, Started::Job(ref j) if j.state == "queued"));
        assert_eq!(
            i.count("SELECT count(*) FROM employees WHERE org_id = $1")
                .await,
            0
        );
        let before = command_outcomes::lookup(&i.f.rt, org, actor, id.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before.state, "APPLIED");
        let terminal = serde_json::to_value(before).unwrap();

        let report =
            i.f.hr
                .drive_apply(Some(i.store.clone()), org, run)
                .await
                .unwrap();
        assert_eq!(report.inserted, 2);
        assert_eq!(i.f.hr.apply_job(org, run).await.unwrap().state, "done");
        assert_eq!(
            i.count("SELECT count(*) FROM employees WHERE org_id = $1")
                .await,
            2
        );
        assert_eq!(command_context::current().unwrap().command_id, Some(id));
        let after = command_outcomes::lookup(&i.f.rt, org, actor, id.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            terminal,
            "terminal HTTP outcome cannot change"
        );

        let events: Vec<(Option<Uuid>, String, String)> = sqlx::query_as(
            "SELECT command_id, source, after_snap->>'state' FROM audit_events \
               WHERE org_id = $1 AND target_type = 'data_import_run' AND target_id = $2 \
                 AND action = 'data_import.apply.progress' ORDER BY created_at, id",
        )
        .bind(i.org())
        .bind(run.to_string())
        .fetch_all(&i.owner)
        .await
        .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.2.as_str())
                .collect::<Vec<_>>(),
            ["queued", "applying", "done"],
            "the final settle chunk publishes done in its own transaction"
        );
        assert_eq!(events.iter().filter(|e| e.0 == Some(id)).count(), 1);
        assert!(events.iter().all(|e| e.1 == "IMPORT"));
        assert!(
            events
                .iter()
                .filter(|e| e.2 != "queued")
                .all(|e| e.0.is_none())
        );
    })
    .await;
}
