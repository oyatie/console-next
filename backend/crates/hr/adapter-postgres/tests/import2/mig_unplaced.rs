//! BE-MIG W03 / E8: the 미배치 queue after an import — counted, with the
//! file's 부서 text and why, keyset-paged, narrowed to one run; a reader
//! without directory management is refused and a forged cursor is 422.

use console_hr_adapter_postgres::import::unplaced::UnplacedQuery;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use sqlx::PgPool;

use crate::harness::{Importer, decisions, importer, table};

async fn import(i: &Importer, file: &str, rows: &[&[&str]]) -> uuid::Uuid {
    let header: &[&str] = &["사번", "성명", "입사일", "고용형태", "부서", "퇴사일"];
    let all: Vec<&[&str]> = std::iter::once(header)
        .chain(rows.iter().copied())
        .collect();
    let run = i
        .preview(
            file,
            &[table("명부", 0, &all)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    i.apply(run, &plan.dry_run_digest).await.unwrap();
    run
}

fn query(run_id: Option<uuid::Uuid>, after: Option<String>, limit: i64) -> UnplacedQuery {
    UnplacedQuery {
        run_id,
        after,
        limit: Some(limit),
    }
}

/// regression (W03): 125 people came in 미배치 with nowhere to find them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_unplaced_people_are_listed_counted_and_paged(pool: PgPool) {
    let i = importer(pool).await;
    let first = import(
        &i,
        "a.xlsx",
        &[
            &["E-1", "김일", "2024-03-04", "정규직", "영업 2팀", ""],
            &["E-2", "김이", "2024-03-04", "정규직", "", ""],
            &["E-3", "김삼", "2020-03-04", "정규직", "", "2023-12-31"],
        ],
    )
    .await;
    let second = import(
        &i,
        "b.xlsx",
        &[&["E-4", "김사", "2024-03-04", "정규직", "", ""]],
    )
    .await;
    let p = || i.f.principal.clone();

    let all =
        i.f.hr
            .import_unplaced(p(), query(None, None, 100))
            .await
            .unwrap();
    assert_eq!(all.count, 3, "the former employee is not in the queue");
    let kim = all.items.iter().find(|r| r.name == "김일").unwrap();
    assert_eq!(
        (kim.reason, kim.source_org_unit.as_deref()),
        ("no_place", Some("영업 2팀"))
    );
    let text = serde_json::to_string(&all.items).unwrap();
    assert!(!text.contains("rrn") && !text.contains("phone"), "{text}");

    let page =
        i.f.hr
            .import_unplaced(p(), query(None, None, 2))
            .await
            .unwrap();
    assert_eq!((page.count, page.items.len()), (3, 2));
    let next = page.next_cursor.clone().unwrap();
    let rest =
        i.f.hr
            .import_unplaced(p(), query(None, Some(next), 2))
            .await
            .unwrap();
    assert_eq!((rest.items.len(), rest.next_cursor.as_deref()), (1, None));
    let mut seen: Vec<_> = page
        .items
        .iter()
        .chain(&rest.items)
        .map(|r| r.name.as_str())
        .collect();
    seen.sort_unstable();
    assert_eq!(
        seen,
        ["김사", "김이", "김일"],
        "two pages, every person once"
    );

    let one =
        i.f.hr
            .import_unplaced(p(), query(Some(second), None, 100))
            .await
            .unwrap();
    assert_eq!((one.count, one.items[0].name.as_str()), (1, "김사"));
    let none =
        i.f.hr
            .import_unplaced(p(), query(Some(first), Some("x".into()), 1))
            .await;
    let refused = none.unwrap_err();
    assert_eq!((refused.status.as_u16(), refused.code), (422, "validation"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reader_without_directory_management_is_refused(pool: PgPool) {
    let i = importer(pool).await;
    import(
        &i,
        "a.xlsx",
        &[&["E-1", "김일", "2024-03-04", "정규직", "", ""]],
    )
    .await;
    let reader = Principal::new(
        UserId::from_uuid(*i.f.principal.user_id.as_uuid()),
        i.f.principal.org_id,
        [Role::Member].into_iter().collect(),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryRead,
        PermissionLevel::Allow,
        BranchScope::All,
    )]);
    let refused =
        i.f.hr
            .import_unplaced(reader, query(None, None, 10))
            .await
            .unwrap_err();
    assert_eq!((refused.status.as_u16(), refused.code), (403, "forbidden"));
}
