// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_compliance_domain::statutory::filing::{FilingAnchors, dates};
use console_hr_adapter_postgres::clock::today_kst;
use console_platform_db::statutory_read::{
    load_statutory_register, load_statutory_register_for_codes,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, macros::date};

// Three distinct test periods ensure the preserved first period cannot mask a missing boundary.
async fn periods(pool: &PgPool, code: &str, starts: [Date; 3], offset: i16, age_trigger: bool) {
    let template: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM statutory_rules r WHERE code=$1 ORDER BY effective_from DESC LIMIT 1")
        .bind(code).fetch_one(pool).await.unwrap();
    sqlx::query("DELETE FROM statutory_rules WHERE code=$1")
        .bind(code)
        .execute(pool)
        .await
        .unwrap();
    for (index, from) in starts.into_iter().enumerate() {
        let mut row = template.clone();
        row["effective_from"] = json!(from.to_string());
        row["effective_to_exclusive"] = json!(starts.get(index + 1).map(ToString::to_string));
        row["enforced_on"] = json!(from.to_string());
        row["filing_rule"]["effective_from"] = row["effective_from"].clone();
        row["filing_rule"]["effective_to_exclusive"] = row["effective_to_exclusive"].clone();
        row["filing_rule"]["citation"]["enforced_on"] = json!(from.to_string());
        row["filing_rule"]["loss_offset_days"] = json!(offset);
        row["filing_rule"]["exclusions"] = json!([]);
        row["filing_rule"]["applicability_unverified"] = json!(false);
        row["filing_rule"]["deadline"] =
            json!({"anchor":"LOSS_DATE","kind":"DAYS","value":index+3,"first_day":"EXCLUDED"});
        row["filing_rule"]["candidate"] = Value::Null;
        row["filing_rule"]["holiday_roll"] = json!("UNVERIFIED");
        row["filing_rule"]["age_trigger_years"] = if age_trigger {
            row["filing_rule"]["filing_kind"] = json!("AGE60");
            json!(if index == 2 { 60 } else { 61 })
        } else {
            Value::Null
        };
        sqlx::query("INSERT INTO statutory_rules SELECT (jsonb_populate_record(NULL::statutory_rules,$1)).*")
            .bind(row).execute(pool).await.unwrap();
    }
}

async fn loss_boundary(
    pool: PgPool,
    on: Date,
    offset: i16,
    expected_from: Date,
    expected_due: Date,
) {
    let code = console_compliance_domain::statutory::codes::resolve("ins.deadline.lose.nhis");
    periods(
        &pool,
        code,
        [
            date!(2034 - 01 - 01),
            date!(2035 - 01 - 01),
            date!(2036 - 01 - 01),
        ],
        offset,
        false,
    )
    .await;
    let mut conn = pool.acquire().await.unwrap();
    let scoped = load_statutory_register_for_codes(&mut conn, &[code.into()], &[on])
        .await
        .unwrap();
    let full = load_statutory_register(&mut conn).await.unwrap();
    let event_rule = scoped.filing_rule_by_code(code, on).unwrap().unwrap();
    let loss = event_rule.loss_on(on).unwrap();
    let rule = scoped.filing_rule_by_code(code, loss).unwrap().unwrap();
    assert_eq!(rule.effective_from, expected_from.to_string());
    let anchors = FilingAnchors {
        effective_date: Some(on),
        exit_date: Some(on),
        loss_date: Some(loss),
        ..Default::default()
    };
    let result = dates(rule, &anchors, &[]).unwrap();
    assert_eq!(result.due_on, Some(expected_due.to_string()));
    assert_eq!(
        result,
        dates(
            full.filing_rule_by_code(code, loss).unwrap().unwrap(),
            &anchors,
            &[]
        )
        .unwrap()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_register_resolves_a_positive_loss_offset_across_the_next_rule_boundary(
    pool: PgPool,
) {
    loss_boundary(
        pool,
        date!(2035 - 12 - 31),
        1,
        date!(2036 - 01 - 01),
        date!(2036 - 01 - 06),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_register_resolves_a_negative_loss_offset_across_the_previous_rule_boundary(
    pool: PgPool,
) {
    loss_boundary(
        pool,
        date!(2036 - 01 - 01),
        -1,
        date!(2035 - 01 - 01),
        date!(2036 - 01 - 04),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn opening_a_historical_hire_case_includes_todays_age_trigger_rule(pool: PgPool) {
    let today = today_kst();
    // A test country pack assigns an age-triggered obligation to an existing hire item.
    sqlx::query("DELETE FROM statutory_rules WHERE filing_rule->>'filing_kind'='AGE60'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE case_template_items SET applicability=ARRAY['INSURER_APPLIES_NPS'] \
        WHERE template_key='HIRE' AND due_register_code='ins.deadline.acquire.nps'",
    )
    .execute(&pool)
    .await
    .unwrap();
    periods(
        &pool,
        "ins.deadline.acquire.nps",
        [
            today - Duration::days(90),
            today - Duration::days(60),
            today - Duration::days(20),
        ],
        0,
        true,
    )
    .await;
    let f = fixture::fixture(pool.clone()).await;
    let birthday = today - Duration::days(10);
    let mut body = f.body("historical-age-trigger", "REGULAR");
    body.hire_date = Some((today - Duration::days(30)).to_string());
    body.birth_date = Some(
        birthday
            .replace_year(birthday.year() - 60)
            .unwrap()
            .to_string(),
    );
    let employee = f.create(body).await.unwrap().employee_id();
    // Read the receipt as written, before a case read can refresh it with the full register.
    let basis: Value = sqlx::query_scalar("SELECT i.due_basis->'applicability' FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
        WHERE c.employee_id=$1 AND c.kind='HIRE' AND i.due_rule_ref='ins.deadline.acquire.nps'")
        .bind(employee).fetch_one(&pool).await.unwrap();
    assert_eq!(
        basis["status"], "APPLIES",
        "the employee turned 60 after hire under the rule in force today"
    );
}
