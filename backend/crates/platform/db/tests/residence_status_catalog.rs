// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use sqlx::PgPool;
use time::{Date, macros::date};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

// The status column of the three annexes, not visa issuance subcategories.
const STATUSES: &[(&str, &str)] = &[
    ("A-1", "외교"),
    ("A-2", "공무"),
    ("A-3", "협정"),
    ("B-1", "사증면제"),
    ("B-2", "관광·통과"),
    ("C-1", "일시취재"),
    ("C-3", "단기방문"),
    ("C-4", "단기취업"),
    ("D-1", "문화예술"),
    ("D-10", "구직"),
    ("D-2", "유학"),
    ("D-3", "기술연수"),
    ("D-4", "일반연수"),
    ("D-5", "취재"),
    ("D-6", "종교"),
    ("D-7", "주재"),
    ("D-8", "기업투자"),
    ("D-9", "무역경영"),
    ("E-1", "교수"),
    ("E-10", "선원취업"),
    ("E-2", "회화지도"),
    ("E-3", "연구"),
    ("E-4", "기술지도"),
    ("E-5", "전문직업"),
    ("E-6", "예술흥행"),
    ("E-7", "특정활동"),
    ("E-8", "계절근로"),
    ("E-9", "비전문취업"),
    ("F-1", "방문동거"),
    ("F-2", "거주"),
    ("F-3", "동반"),
    ("F-4", "재외동포"),
    ("F-5", "영주"),
    ("F-6", "결혼이민"),
    ("G-1", "기타"),
    ("H-1", "관광취업"),
    ("H-2", "방문취업"),
];

#[sqlx::test(migrator = "MIGRATOR")]
async fn residence_catalog_matches_all_three_current_annexes(pool: PgPool) {
    let rows: Vec<(String, String, String, String, Date, Option<Date>)> = sqlx::query_as(
        "SELECT code,label_ko,label_en,publisher,valid_from,valid_to FROM residence_status_versions ORDER BY code",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 37);
    assert_eq!(
        rows.iter()
            .map(|r| (r.0.as_str(), r.1.as_str()))
            .collect::<Vec<_>>(),
        STATUSES
    );
    for (_, _, english, publisher, from, to) in rows {
        assert!(!english.trim().is_empty());
        assert_eq!(publisher, "법무부");
        assert_eq!(from, date!(2026 - 10 - 02));
        assert_eq!(to, None);
    }
    let countries: Vec<String> = sqlx::query_scalar("SELECT DISTINCT c.code FROM residence_status_codes r JOIN country_codes c ON c.code=r.country_code")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(countries, ["KR"]);
    let error = sqlx::query("UPDATE residence_status_codes SET country_code='ZZ' WHERE code='E-7'")
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    let identities: Vec<String> =
        sqlx::query_scalar("SELECT code FROM residence_status_codes ORDER BY code")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(identities, STATUSES.iter().map(|s| s.0).collect::<Vec<_>>());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn residence_versions_preserve_history_and_reject_invalid_metadata(pool: PgPool) {
    for (sql, state) in [
        (
            "INSERT INTO residence_status_codes(code,country_code) VALUES ('E-7-1','KR')",
            "23514",
        ),
        (
            "INSERT INTO residence_status_versions VALUES ('Z-1','시험','Test','법무부','2026-10-02',NULL)",
            "23503",
        ),
        (
            "INSERT INTO residence_status_versions VALUES ('E-7','시험','Test','법무부','2026-10-02','2027-01-01')",
            "23505",
        ),
        (
            "INSERT INTO residence_status_versions VALUES ('E-7','시험','Test','법무부','2027-01-01',NULL)",
            "23505",
        ),
        (
            "UPDATE residence_status_versions SET valid_to=valid_from WHERE code='E-7'",
            "23514",
        ),
        (
            "UPDATE residence_status_versions SET label_ko=' ' WHERE code='E-7'",
            "23514",
        ),
        (
            "UPDATE residence_status_versions SET label_en=' ' WHERE code='E-7'",
            "23514",
        ),
        (
            "UPDATE residence_status_versions SET publisher=' ' WHERE code='E-7'",
            "23514",
        ),
        (
            "DELETE FROM residence_status_codes WHERE code='E-7'",
            "23001",
        ),
    ] {
        let error = sqlx::query(sql).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(state),
            "{sql}"
        );
    }
    sqlx::query("UPDATE residence_status_versions SET valid_to='2027-01-01' WHERE code='E-7'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO residence_status_versions VALUES ('E-7','변경 명칭','Updated label','법무부','2027-01-01',NULL)").execute(&pool).await.unwrap();
    for (on, expected) in [
        (date!(2026 - 10 - 01), None),
        (date!(2026 - 10 - 02), Some("특정활동")),
        (date!(2026 - 12 - 31), Some("특정활동")),
        (date!(2027 - 01 - 01), Some("변경 명칭")),
    ] {
        let label: Option<String> = sqlx::query_scalar("SELECT label_ko FROM residence_status_versions WHERE code='E-7' AND valid_from <= $1 AND (valid_to IS NULL OR $1 < valid_to)")
            .bind(on).fetch_optional(&pool).await.unwrap();
        assert_eq!(label.as_deref(), expected);
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn residence_reference_is_global_and_runtime_read_only(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("SET ROLE console_rt")
        .execute(&mut *conn)
        .await
        .unwrap();
    for org in [uuid::Uuid::new_v4(), uuid::Uuid::new_v4()] {
        sqlx::query("SELECT set_config('app.current_org',$1,false)")
            .bind(org.to_string())
            .execute(&mut *conn)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM residence_status_versions")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(count, 37);
    }
    for sql in [
        "INSERT INTO residence_status_codes(code,country_code) VALUES ('Z-1','KR')",
        "UPDATE residence_status_codes SET code='Z-1' WHERE code='E-7'",
        "DELETE FROM residence_status_codes WHERE code='E-7'",
        "TRUNCATE residence_status_codes CASCADE",
        "INSERT INTO residence_status_versions VALUES ('E-7','시험','Test','법무부','2027-01-01',NULL)",
        "UPDATE residence_status_versions SET label_ko='시험' WHERE code='E-7'",
        "DELETE FROM residence_status_versions WHERE code='E-7'",
        "TRUNCATE residence_status_versions",
    ] {
        let error = sqlx::query(sql).execute(&mut *conn).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "{sql}"
        );
    }
}
