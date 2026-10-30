// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

fn rules() -> Value {
    json!({"name":"모의 급여", "pay_date_rule":{"day":"LAST_DAY","month_offset":0,"non_business_day":"PREVIOUS"},
        "base_period":{"start_day":"FIRST","month_offset":0},
        "variable_period":{"start_day":16,"month_offset":-1},
        "proration":"CALENDAR_DAYS","channel":"ATTESTATION_ONLY"})
}

async fn insert(tx: &mut Transaction<'_, Postgres>, value: Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO pay_groups SELECT (jsonb_populate_record(NULL::pay_groups,$1)).*")
        .bind(value)
        .execute(tx.as_mut())
        .await
        .map(|_| ())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_refuses_invalid_rule_types_and_missing_choices(pool: PgPool) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    seed_org_and_super_admin(&pool, *org.as_uuid(), "typed-pay-group").await;
    // rls-arming: ok owner seeds the legal entity before runtime writes.
    let entity: Uuid = sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).fetch_one(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    let invalid = [
        ("pay_date_rule", json!("매월 말일")),
        (
            "pay_date_rule",
            json!({"day":0,"month_offset":0,"non_business_day":"PREVIOUS"}),
        ),
        (
            "pay_date_rule",
            json!({"day":32,"month_offset":0,"non_business_day":"PREVIOUS"}),
        ),
        (
            "pay_date_rule",
            json!({"day":1.5,"month_offset":0,"non_business_day":"PREVIOUS"}),
        ),
        (
            "pay_date_rule",
            json!({"day":"1","month_offset":0,"non_business_day":"PREVIOUS"}),
        ),
        (
            "pay_date_rule",
            json!({"day":1,"month_offset":-1,"non_business_day":"PREVIOUS"}),
        ),
        (
            "pay_date_rule",
            json!({"day":1,"month_offset":2,"non_business_day":"NEXT"}),
        ),
        (
            "pay_date_rule",
            json!({"day":1,"month_offset":0,"non_business_day":"NONE"}),
        ),
        ("pay_date_rule", json!({"day":1,"month_offset":0})),
        (
            "pay_date_rule",
            json!({"day":1,"month_offset":0,"non_business_day":null}),
        ),
        (
            "pay_date_rule",
            json!({"day":1,"month_offset":0,"non_business_day":"NEXT","extra":true}),
        ),
        ("base_period", json!({"start_day":0,"month_offset":0})),
        ("base_period", json!({"start_day":29,"month_offset":0})),
        (
            "base_period",
            json!({"start_day":"LAST_DAY","month_offset":0}),
        ),
        ("base_period", json!({"start_day":1,"month_offset":1})),
        ("base_period", json!({"start_day":1,"month_offset":-2})),
        ("base_period", json!({"start_day":null,"month_offset":0})),
        ("variable_period", json!({"start_day":1})),
        ("variable_period", json!({"start_day":1.5,"month_offset":0})),
        ("variable_period", json!({"start_day":"1","month_offset":0})),
        (
            "variable_period",
            json!({"start_day":1,"month_offset":0,"extra":true}),
        ),
        ("name", json!("가".repeat(41))),
        ("name", json!(format!(" {} ", "가".repeat(40)))),
        ("name", json!(" ")),
        ("proration", json!("OTHER")),
        ("channel", json!("BANK_TRANSFER")),
    ];
    for (field, value) in invalid.into_iter().chain(
        [
            "name",
            "pay_date_rule",
            "base_period",
            "variable_period",
            "proration",
            "channel",
        ]
        .map(|f| (f, Value::Null)),
    ) {
        let mut input = rules();
        input["org_id"] = json!(org.as_uuid());
        input["id"] = json!(Uuid::new_v4());
        input["legal_entity_id"] = json!(entity);
        input[field] = value;
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = insert(&mut tx, input.clone())
            .await
            .expect_err(&format!("accepted {field}: {}", input[field]));
        let expected = if input[field].is_null() {
            "23502"
        } else {
            "23514"
        };
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(expected)
        );
    }
}

#[test]
fn wire_refuses_free_text_unknown_enums_and_absent_fields() {
    use console_payroll_adapter_postgres::pay_groups::CreatePayGroup;
    let mut valid = rules();
    valid["legal_entity_id"] = json!(Uuid::new_v4());
    assert!(serde_json::from_value::<CreatePayGroup>(valid.clone()).is_ok());
    for field in [
        "name",
        "pay_date_rule",
        "base_period",
        "variable_period",
        "proration",
        "channel",
    ] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<CreatePayGroup>(missing).is_err(),
            "defaulted {field}"
        );
    }
    for field in [
        "pay_date_rule",
        "base_period",
        "variable_period",
        "proration",
        "channel",
    ] {
        let mut invalid = valid.clone();
        invalid[field] = json!("arbitrary");
        assert!(
            serde_json::from_value::<CreatePayGroup>(invalid).is_err(),
            "accepted free text for {field}"
        );
    }
}

#[test]
fn additive_migration_declares_its_class() {
    let migration =
        include_str!("../../../platform/db/migrations/20261030000000000_pay_groups.sql");
    assert_eq!(migration.lines().nth(1), Some("-- migration-class: expand"));
}

#[test]
fn nested_rules_refuse_unknown_enums_and_missing_consequential_choices() {
    use console_payroll_adapter_postgres::pay_groups::CreatePayGroup;
    let mut valid = rules();
    valid["legal_entity_id"] = json!(Uuid::new_v4());
    for (field, keys) in [
        (
            "pay_date_rule",
            vec!["day", "month_offset", "non_business_day"],
        ),
        ("base_period", vec!["start_day", "month_offset"]),
        ("variable_period", vec!["start_day", "month_offset"]),
    ] {
        for key in keys {
            let mut missing = valid.clone();
            missing[field].as_object_mut().unwrap().remove(key);
            assert!(
                serde_json::from_value::<CreatePayGroup>(missing).is_err(),
                "defaulted {field}.{key}"
            );
        }
        let mut extra = valid.clone();
        extra[field]["extra"] = json!(true);
        assert!(serde_json::from_value::<CreatePayGroup>(extra).is_err());
    }
    for (field, key, value) in [
        ("pay_date_rule", "day", json!("FIRST")),
        ("pay_date_rule", "non_business_day", json!("NONE")),
        ("base_period", "start_day", json!("LAST_DAY")),
        ("variable_period", "start_day", json!("16")),
    ] {
        let mut invalid = valid.clone();
        invalid[field][key] = value;
        assert!(serde_json::from_value::<CreatePayGroup>(invalid).is_err());
    }
}
