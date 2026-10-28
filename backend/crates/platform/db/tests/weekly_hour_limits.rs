// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_compliance_domain::statutory::{StatutoryUnit, codes};
use console_platform_db::statutory_read::load_statutory_register;
use console_settings_domain::{LooserWhen, SettingKey, SettingKind, Unit};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, macros::date};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
const HORIZON_DAYS: i64 = 90; // REFDATA-2027 S3: next statutory cliff.
const CODES: [&str; 2] = ["WEEKLY_STANDARD_HOURS", "WEEKLY_OVERTIME_MAX_HOURS"];

#[sqlx::test(migrator = "MIGRATOR")]
async fn weekly_register_covers_each_slice_and_the_live_horizon(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    let register = load_statutory_register(&mut conn).await.unwrap();
    for on in [
        date!(2026 - 10 - 08),
        date!(2026 - 12 - 08),
        date!(2026 - 12 - 10),
        date!(2027 - 01 - 01),
    ] {
        for (code, hours) in CODES.into_iter().zip([40, 12]) {
            let row = register.rule(code, on).unwrap();
            assert_eq!(row.whole(StatutoryUnit::HoursPerWeek).unwrap(), hours);
            assert_eq!(row.effective_from, on);
            assert!(row.disposition.is_hold());
            assert!(row.effective_to_exclusive.is_some());
        }
    }
    let today = OffsetDateTime::now_utc().date();
    for offset in 0..=HORIZON_DAYS {
        for code in CODES {
            register.rule(code, today + Duration::days(offset)).unwrap();
        }
    }
    let rows: Vec<(String, Date)> = sqlx::query_as("SELECT code,effective_from FROM statutory_rules WHERE code=ANY($1) ORDER BY code,effective_from")
        .bind(CODES).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 8);
    for (code, from) in rows {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("DELETE FROM statutory_rules WHERE code=$1 AND effective_from=$2")
            .bind(&code)
            .bind(from)
            .execute(&mut *tx)
            .await
            .unwrap();
        let register = load_statutory_register(&mut tx).await.unwrap();
        let error = register.rule(&code, from).unwrap_err().to_string();
        assert!(
            error.contains(&code) && error.contains(&from.to_string()),
            "{error}"
        );
        tx.rollback().await.unwrap();
    }
    let invalid_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM statutory_rules WHERE code=ANY($1) AND (btrim(instrument_ko)='' OR btrim(article_ko)='' OR btrim(promulgation_ko)='' OR btrim(source_url)='' OR retrieved_on IS NULL OR effective_from<enforced_on OR release_disposition<>'HOLD')")
        .bind(CODES).fetch_one(&pool).await.unwrap();
    assert_eq!(invalid_rows, 0);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn weekly_warning_bounds_match_the_register_and_sql_refuses_the_danger_line(pool: PgPool) {
    let key: SettingKey = "attendance.week52.warn_hours".parse().unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let register = load_statutory_register(&mut conn).await.unwrap();
    let today = OffsetDateTime::now_utc().date();
    let standard = register
        .rule(CODES[0], today)
        .unwrap()
        .whole(StatutoryUnit::HoursPerWeek)
        .unwrap();
    let overtime = register
        .rule(CODES[1], today)
        .unwrap()
        .whole(StatutoryUnit::HoursPerWeek)
        .unwrap();
    assert_eq!(
        key.def().kind,
        SettingKind::Int {
            unit: Unit::Hours,
            min: Some(standard),
            max: Some(standard + overtime - 1)
        }
    );
    assert_eq!(key.def().looser_when, LooserWhen::Higher);
    assert!(key.def().legal_basis.is_some());
    let sql_bounds: (i64, i64) =
        sqlx::query_as("SELECT min_value,max_value FROM setting_definition($1)")
            .bind(key.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sql_bounds, (standard, standard + overtime - 1));
    // The existing settings trigger checks bounds before change governance.
    let error = sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES($1,$2,$3,now(),$4,'X')")
        .bind(uuid::Uuid::new_v4()).bind(key.as_str()).bind(serde_json::json!(standard+overtime))
        .bind(uuid::Uuid::new_v4()).execute(&pool).await.unwrap_err();
    assert!(
        error.to_string().contains("setting_out_of_range"),
        "{error}"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn both_code_checks_keep_the_full_domain_roster(pool: PgPool) {
    let mut combined = std::collections::BTreeSet::new();
    for table in ["statutory_rules", "statutory_filing_drafts"] {
        let actual: Vec<String> = sqlx::query_scalar("SELECT DISTINCT (regexp_matches(pg_get_constraintdef(c.oid), $re$'([^']+)'$re$, 'g'))[1] FROM pg_constraint c WHERE c.conrelid=$1::regclass AND c.contype='c' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='code')]::smallint[]")
            .bind(table).fetch_all(&pool).await.unwrap();
        for code in CODES {
            assert_eq!(
                actual.iter().any(|c| c == code),
                table == "statutory_rules",
                "{table}: {code}"
            );
        }
        assert!(combined.is_disjoint(&actual.iter().cloned().collect()));
        combined.extend(actual);
    }
    assert_eq!(
        combined,
        codes::ALL.into_iter().map(str::to_owned).collect()
    );
}
