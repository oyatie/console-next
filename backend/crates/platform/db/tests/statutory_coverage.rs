// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use sqlx::{PgConnection, PgPool};
use time::{Date, Duration, OffsetDateTime, macros::date};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
// REFDATA-2027 S1: see the next statutory cliff 90 days before payroll needs it.
const COVERAGE_HORIZON_DAYS: i64 = 90;

#[derive(Clone, Copy)]
struct Obligation {
    code: &'static str,
    from: Date,
    reason: &'static str,
    watch_url: &'static str,
    expires_on: Date,
}
const WAIVERS: &[Obligation] = &[
    Obligation {
        code: "LONG_TERM_CARE_TOTAL",
        from: date!(2027 - 01 - 01),
        reason: "장기요양위원회 결정 대기",
        watch_url: "https://www.mohw.go.kr/board.es?mid=a10503000000&bid=0027",
        expires_on: date!(2026 - 12 - 24),
    },
    Obligation {
        code: "HEALTH_PREMIUM_BAND",
        from: date!(2027 - 01 - 01),
        reason: "보건복지부 상·하한 고시 대기",
        watch_url: "https://www.law.go.kr/LSW/admRulInfoR.do?admRulSeq=2100000270472",
        expires_on: date!(2026 - 12 - 24),
    },
    Obligation {
        code: "SIMPLIFIED_WITHHOLDING_TABLE",
        from: date!(2027 - 01 - 01),
        reason: "REFDATA-2027 S5 / 세무사 검토 필요",
        watch_url: "https://www.law.go.kr/법령/소득세법시행령",
        expires_on: date!(2026 - 12 - 24),
    },
];
const WATCHES: &[Obligation] = &[Obligation {
    code: "EMPLOYMENT_INSURANCE_EMPLOYEE",
    from: date!(2027 - 01 - 01),
    reason: "2.0% 인상 발표, 시행령 미공포 — 재확인 필요",
    watch_url: "https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=19866",
    expires_on: date!(2026 - 12 - 24),
}];

type Gap = (String, Date, String);
async fn coverage_gaps(
    conn: &mut PgConnection,
    today: Date,
    horizon: i64,
    waivers: &[Obligation],
    watches: &[Obligation],
) -> Vec<Gap> {
    let codes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT (regexp_matches(pg_get_constraintdef(c.oid), $re$'([^']+)'$re$, 'g'))[1] \
         FROM pg_constraint c WHERE c.conrelid = 'payroll_statutory_rates'::regclass AND c.contype = 'c' \
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'code')]::smallint[]"
    ).fetch_all(&mut *conn).await.unwrap();
    assert!(
        !codes.is_empty(),
        "coverage cannot silently skip the code CHECK"
    );
    let counts: Vec<(String, Date, i64)> = sqlx::query_as(
        "SELECT code, day::date, (SELECT count(*) FROM payroll_statutory_rates r \
         WHERE r.code = codes.code AND r.effective_from <= day::date AND r.effective_to_exclusive > day::date) \
         FROM unnest($1::text[]) AS codes(code) CROSS JOIN generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') AS days(day)"
    ).bind(&codes).bind(today).bind(today + Duration::days(horizon)).fetch_all(&mut *conn).await.unwrap();
    let mut gaps = Vec::new();
    for obligation in waivers.iter().chain(watches) {
        assert!(codes.iter().any(|code| code == obligation.code));
        assert!(obligation.expires_on <= obligation.from && !obligation.reason.trim().is_empty());
        assert!(obligation.watch_url.starts_with("https://"));
        if today >= obligation.expires_on {
            gaps.push((
                obligation.code.into(),
                obligation.expires_on,
                format!("EXPIRED: {} {}", obligation.reason, obligation.watch_url),
            ));
        }
    }
    for (code, day, count) in counts {
        let waived = count == 0
            && waivers
                .iter()
                .any(|w| w.code == code && day >= w.from && today < w.expires_on);
        if count != 1 && !waived {
            gaps.push((code, day, format!("COVERAGE_COUNT={count}")));
        }
    }
    gaps
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn payroll_rates_cover_fixed_and_live_90_day_horizons(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    for today in [date!(2026 - 11 - 01), OffsetDateTime::now_utc().date()] {
        let gaps = coverage_gaps(&mut conn, today, COVERAGE_HORIZON_DAYS, WAIVERS, WATCHES).await;
        assert!(gaps.is_empty(), "{today}: {gaps:#?}");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn deleting_each_covered_row_names_its_code_and_first_missing_day(pool: PgPool) {
    let rows: Vec<(String, Date)> = sqlx::query_as("SELECT code, effective_from FROM payroll_statutory_rates WHERE effective_from <= '2027-01-30' AND effective_to_exclusive > '2026-11-01'").fetch_all(&pool).await.unwrap();
    assert!(
        rows.iter()
            .any(|(code, from)| code == "NATIONAL_PENSION_EMPLOYEE"
                && *from == date!(2027 - 01 - 01))
    );
    for (code, from) in rows {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("DELETE FROM payroll_statutory_rates WHERE code = $1 AND effective_from = $2")
            .bind(&code)
            .bind(from)
            .execute(&mut *tx)
            .await
            .unwrap();
        let gaps = coverage_gaps(
            &mut tx,
            date!(2026 - 11 - 01),
            COVERAGE_HORIZON_DAYS,
            WAIVERS,
            WATCHES,
        )
        .await;
        let day = from.max(date!(2026 - 11 - 01));
        assert!(
            gaps.iter().any(|g| g.0 == code && g.1 == day),
            "{code} {day}: {gaps:#?}"
        );
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn zero_row_codes_overlaps_expired_waivers_and_watches_are_red(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("DELETE FROM payroll_statutory_rates WHERE code = 'MINIMUM_WAGE'")
        .execute(&mut *tx)
        .await
        .unwrap();
    let gaps = coverage_gaps(
        &mut tx,
        date!(2026 - 11 - 01),
        COVERAGE_HORIZON_DAYS,
        WAIVERS,
        WATCHES,
    )
    .await;
    assert_eq!(gaps.iter().filter(|g| g.0 == "MINIMUM_WAGE").count(), 91);
    tx.rollback().await.unwrap();
    let mut conn = pool.acquire().await.unwrap();
    for obligation in WAIVERS.iter().chain(WATCHES) {
        let gaps = coverage_gaps(
            &mut conn,
            obligation.expires_on,
            COVERAGE_HORIZON_DAYS,
            WAIVERS,
            WATCHES,
        )
        .await;
        assert!(gaps.iter().any(|g| g.0 == obligation.code
            && g.1 == obligation.expires_on
            && g.2.starts_with("EXPIRED:")));
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE payroll_statutory_rates SET effective_to_exclusive = '2026-12-01' WHERE code = 'LONG_TERM_CARE_TOTAL' AND effective_from = '2026-01-01'").execute(&mut *tx).await.unwrap();
    let gaps = coverage_gaps(
        &mut tx,
        date!(2026 - 11 - 01),
        COVERAGE_HORIZON_DAYS,
        WAIVERS,
        WATCHES,
    )
    .await;
    assert!(gaps.iter().any(|g| g.0 == "LONG_TERM_CARE_TOTAL"
        && g.1 == date!(2026 - 11 - 27)
        && g.2 == "COVERAGE_COUNT=2"));
}
