// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_app::build_router;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn options_are_actor_only_codes_with_registered_clocks_in_setup(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Privacy test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let user = seed_user(&pool, org, "MEMBER").await;
    let keys = keys();
    let bearer = token(&pool, &keys, org, user, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1).unwrap());
    let uri = "/api/v1/privacy/rights-requests/options";
    let (status, _) = send(&service, "GET", uri, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE statutory_rules SET value_num=17 WHERE code='PIPA_ACCESS_RESPONSE_DAYS'")
        .execute(&pool)
        .await
        .unwrap();
    let today = OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date();
    let (status, options) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    assert_eq!(options["subject_user_id"], user.to_string());
    assert_eq!(options["as_of"], today.to_string());
    assert_eq!(options["controllers"], json!([{"code":"OPERATOR"}]));
    assert_eq!(options["detail_max_length"], 2000);
    assert!(options["reply_email_masked"].is_null());
    let kinds = options["kinds"].as_array().unwrap();
    assert_eq!(
        kinds
            .iter()
            .map(|k| k["code"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "ACCESS",
            "CORRECTION",
            "DELETION",
            "SUSPENSION",
            "WITHDRAWAL"
        ]
    );
    assert_eq!(
        kinds[0],
        json!({"code":"ACCESS", "due_on":(today + time::Duration::days(17)).to_string(), "without_delay":false})
    );
    assert_eq!(
        kinds[4],
        json!({"code":"WITHDRAWAL", "due_on":null, "without_delay":true})
    );
    assert!(kinds.iter().all(|k| k.as_object().unwrap().len() == 3));
    let (status, _) = send(
        &service,
        "GET",
        &format!("{uri}?subject_user_id={}", Uuid::new_v4()),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "subject selection must be refused"
    );
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let (status, operating) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{operating}");
    assert_eq!(
        operating, options,
        "setup and operating must expose the same self-service choices"
    );
    sqlx::query("DELETE FROM statutory_rules WHERE code='PIPA_ACCESS_RESPONSE_DAYS'")
        .execute(&pool)
        .await
        .unwrap();
    let (status, missing) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{missing}");
    assert_eq!(
        missing["kinds"][0],
        json!({"code":"ACCESS", "due_on":null, "without_delay":false})
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn options_follow_live_employee_link_and_never_other_subjects(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Privacy test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let user = seed_user(&pool, org, "MEMBER").await;
    let employee = Uuid::new_v4();
    sqlx::query("INSERT INTO employees(id,org_id,company,name,employee_number,source_filename,source_sheet,source_row,source_key,work_email) VALUES($1,$2,'Test','Subject',$3,'test.csv','people',1,$3,'subject@example.test')")
        .bind(employee).bind(org).bind(employee.to_string()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(user.as_uuid())
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let bearer = token(&pool, &keys, org, user, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1).unwrap());
    let uri = "/api/v1/privacy/rights-requests/options";
    let (status, options) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    assert_eq!(
        options["controllers"],
        json!([{"code":"TENANT"},{"code":"OPERATOR"}])
    );
    assert!(
        options["reply_email_masked"].is_null(),
        "employee contact is not an account delivery address"
    );
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, options) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    assert_eq!(options["controllers"], json!([{"code":"OPERATOR"}]));
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = send(&service, "GET", uri, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
