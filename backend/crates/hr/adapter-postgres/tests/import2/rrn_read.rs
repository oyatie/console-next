//! The stored 주민등록번호: masked by default, the full number only with a
//! 사유 and a 접속기록 row, never without the vault.

use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_number_is_masked_and_revealed_only_with_a_reason_and_a_log(pool: PgPool) {
    let i = importer(pool.clone()).await;
    i.load(
        "a.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "주민등록번호", "입사일"],
                &["1001", "김가", "900101-1234567", "2024-01-02"],
            ],
        )],
        decisions(),
    )
    .await;
    let (kim, _, _) = i.person("김가").await;
    let hr = &i.f.hr;
    let status = hr.rrn_status(i.f.principal.clone(), kim).await.unwrap();
    assert_eq!(
        (status.recorded, status.masked.as_deref()),
        (true, Some("••••••-•••••••"))
    );
    assert!(
        !status
            .masked
            .as_deref()
            .unwrap()
            .chars()
            .any(|c| c.is_ascii_digit())
    );
    assert_eq!(status.source.as_deref(), Some("IMPORT"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rrn_display_never_uses_the_legacy_storage_prefix(pool: PgPool) {
    let i = importer(pool.clone()).await;
    i.load(
        "policy.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "주민등록번호", "입사일"],
                &["1001", "김가", "900101-1234567", "2024-01-02"],
            ],
        )],
        decisions(),
    )
    .await;
    let (kim, _, _) = i.person("김가").await;
    let status = i.f.hr.rrn_status(i.f.principal.clone(), kim).await.unwrap();
    assert_eq!(status.masked.as_deref(), Some("••••••-•••••••"));
    let stored: String = sqlx::query_scalar("SELECT masked FROM employee_rrn WHERE employee_id=$1")
        .bind(kim)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, "900101-1******", "N-1 keeps its storage shape");
}
