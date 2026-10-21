//! A workbook of three layouts: a roster, a titled English sheet and a work
//! log. The log blocks apply until skipped; then people come in with their
//! 사번 (or the rule's), their 휴직 as a setup fact and their RRN sealed.

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use sqlx::PgPool;

use crate::harness::{decisions, grid, importer, map, table};

fn sheets() -> Vec<console_hr_domain::import::grid::GridSheet> {
    let header: &[&str] = &[
        "사번",
        "성명",
        "주민등록번호",
        "입사일",
        "재직상태",
        "휴직시작일",
        "휴직구분",
        "복직예정일",
    ];
    let kim: &[&str] = &[
        "1001",
        "김가",
        "900101-1234567",
        "2024-03-04",
        "재직",
        "",
        "",
        "",
    ];
    let lee: &[&str] = &[
        "1002",
        "이나",
        "850505-2234567",
        "2023-01-02",
        "휴직",
        "2026-03-02",
        "육아휴직",
        "2027-03-01",
    ];
    let park: &[&str] = &["", "박다", "", "2025-02-03", "", "", "", ""];
    let roster = table("명부", 0, &[header, kim, lee, park]);
    let mut titled = table(
        "2공장",
        2,
        &[
            &["Employee Name", "Hire Date", "Employment Status"],
            &["최라", "2024-05-06", "active"],
        ],
    );
    titled
        .rows
        .insert(0, grid("t", &[(0, 0, "2공장 인원 현황")]).rows.remove(0));
    let log = grid(
        "업무일지",
        &[
            (0, 0, "일자"),
            (0, 1, "담당"),
            (1, 0, "2026-05-27"),
            (1, 1, "가"),
        ],
    );
    vec![roster, titled, log]
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn three_layouts_import_once_the_unrecognised_sheet_is_answered(pool: PgPool) {
    let i = importer(pool).await;
    let preview = i
        .preview("people.xlsx", &sheets(), &WorkbookMappingRequest::default())
        .await
        .unwrap();
    assert_eq!(
        (preview.sheets_needing_mapping, preview.sealed_identities),
        (1, 2)
    );
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_rows WHERE org_id = $1 AND raw_row::text LIKE '%234567%'")
            .await,
        0,
        "an RRN never enters a raw row"
    );
    let plan = i.dry_run(preview.run_id, decisions()).await;
    assert_eq!(plan.review.blocking, 1);
    assert_eq!(plan.review.items[0].reason, "sheet_needs_mapping");
    let refused = i
        .apply(preview.run_id, &plan.dry_run_digest)
        .await
        .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "import_unresolved")
    );

    let skip = WorkbookMappingRequest {
        sheets: map(&[(
            "업무일지",
            SheetMappingRequest {
                skip: Some(true),
                ..SheetMappingRequest::default()
            },
        )]),
    };
    let run = i
        .preview("people.xlsx", &sheets(), &skip)
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    let numbered: Vec<_> = plan
        .rows
        .iter()
        .filter_map(|r| r.new_person.as_ref())
        .filter(|p| p.employee_number_source == Some("rule"))
        .collect();
    assert_eq!(
        numbered.len(),
        2,
        "박다 and 최라 are numbered in the preview"
    );
    let report = i.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(report.inserted, 4);

    let (_, number, status) = i.person("김가").await;
    assert_eq!(
        (number.as_deref(), status.as_str()),
        (Some("1001"), "ACTIVE")
    );
    let (on_leave, _, status) = i.person("이나").await;
    assert_eq!(status, "ON_LEAVE");
    let leave: (String, String) = sqlx::query_as(
        "SELECT effective_date, leave_type FROM employee_lifecycle_events \
         WHERE employee_id = $1 AND event_type = 'LEAVE_OF_ABSENCE'",
    )
    .bind(on_leave)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(leave, ("2026-03-02".into(), "CHILDCARE".into()));
    let (_, number, _) = i.person("박다").await;
    assert!(number.unwrap().starts_with("E-"));
    assert_eq!(
        i.count("SELECT count(*) FROM employee_rrn WHERE org_id = $1")
            .await,
        2
    );
    let staged: Vec<uuid::Uuid> =
        sqlx::query_scalar("SELECT run_id FROM data_import_row_identities WHERE org_id = $1")
            .bind(i.org())
            .fetch_all(&i.owner)
            .await
            .unwrap();
    // The applied run's identities moved; the blocked first run keeps its
    // own until the TTL purge.
    assert!(
        !staged.contains(&run),
        "staged identities leave with the apply"
    );
    assert_eq!(staged.len(), 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_run_older_than_the_staged_identity_ttl_is_refused_not_applied_without_its_rrn(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let roster = table(
        "명부",
        0,
        &[
            &["사번", "성명", "주민등록번호", "입사일"],
            &["1001", "김가", "900101-1234567", "2024-03-04"],
        ],
    );
    let run = i
        .preview(
            "old.xlsx",
            std::slice::from_ref(&roster),
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    sqlx::query("UPDATE data_import_runs SET created_at = now() - interval '8 days' WHERE id = $1")
        .bind(run)
        .execute(&i.owner)
        .await
        .unwrap();
    let refused = i.apply(run, &plan.dry_run_digest).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "import_run_expired")
    );
    // The next preview purges what the expired run had staged.
    sqlx::query("UPDATE data_import_row_identities SET created_at = now() - interval '8 days'")
        .execute(&i.owner)
        .await
        .unwrap();
    i.preview("new.xlsx", &[roster], &WorkbookMappingRequest::default())
        .await
        .unwrap();
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM data_import_row_identities WHERE run_id = $1")
            .bind(run)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(left, 0);
}
