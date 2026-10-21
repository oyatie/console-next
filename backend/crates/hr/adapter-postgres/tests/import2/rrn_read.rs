//! The stored 주민등록번호: masked by default, the full number only with a
//! 사유 and a 접속기록 row, never without the vault.

use console_hr_adapter_postgres::rrn::RrnRevealRequest;
use sqlx::PgPool;

use crate::harness::{MirrorVault, decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_number_is_masked_and_revealed_only_with_a_reason_and_a_log(pool: PgPool) {
    let i = importer(pool).await;
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
        (true, Some("900101-1******"))
    );
    assert_eq!(status.source.as_deref(), Some("IMPORT"));
    let ask = |code: &str| RrnRevealRequest {
        reason_code: code.into(),
        note: None,
    };
    let shown = hr
        .rrn_reveal(
            i.f.principal.clone(),
            kim,
            ask("IDENTITY_VERIFICATION"),
            Some(&MirrorVault),
        )
        .await
        .unwrap();
    assert_eq!(shown.rrn, "900101-1234567");
    let logged = i
        .count("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.rrn_reveal'")
        .await;
    assert_eq!(logged, 1);
    assert_eq!(
        i.count("SELECT count(*) FROM audit_events WHERE org_id = $1 AND after_snap::text LIKE '%234567%'")
            .await,
        0,
        "the number is never in an audit row"
    );
    assert!(
        hr.rrn_reveal(
            i.f.principal.clone(),
            kim,
            ask("NOT_A_CODE"),
            Some(&MirrorVault)
        )
        .await
        .is_err()
    );
    let off = hr
        .rrn_reveal(
            i.f.principal.clone(),
            kim,
            ask("IDENTITY_VERIFICATION"),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        (off.status.as_u16(), off.code),
        (503, "rrn_vault_unavailable")
    );
}
