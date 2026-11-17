// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Birth date, address, phone and personal email open only through the governed
//! reveal (reason, passkey step-up, rate limit, access record). Every other read,
//! and every write response or refusal, carries the reveal module's mask.
#[path = "masked_personal_reads/answers.rs"]
mod answers;
#[path = "support/http.rs"]
mod support;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Ctx, ctx, employee_body, structure, tenant, today_kst};
use uuid::Uuid;

const BIRTH: &str = "1990-04-17";
const EMAIL: &str = "masked-reads@example.invalid";
const ROAD: &str = "Synthetic-si Synthetic-gu 7 Mask-ro";
const DETAIL: &str = "Unit 101 Synthetic-dong";
/// `employee_body`'s phone, 010-1234-0000, in any stored or display form.
const PHONE_DIGITS: [&str; 2] = ["12340000", "1234-0000"];

fn closed(body: &Value) {
    let text = body.to_string();
    for clear in [BIRTH, EMAIL, ROAD, DETAIL, PHONE_DIGITS[0], PHONE_DIGITS[1]] {
        assert!(!text.contains(clear), "{clear} in {text}");
    }
}

async fn person(pool: &PgPool) -> (Ctx, String) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let c = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = structure(&c).await;
    let (s, e) = c
        .call(
            "POST",
            "/api/v1/employees",
            Some(employee_body("MASK-1", &branch, &unit)),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    closed(&e);
    let id = e["employee"]["id"].as_str().unwrap().to_owned();
    let (s, v) = c
        .call(
            "PATCH",
            &format!("/api/v1/employees/{id}/employment-facts"),
            Some(json!([{"op":"test","path":"/birth_date","value":null},{"op":"replace","path":"/birth_date","value":BIRTH}])),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    closed(&v);
    let employee: Uuid = id.parse().unwrap();
    let address: Uuid = sqlx::query_scalar("INSERT INTO employee_addresses(org_id,employee_id,source,road_addr_part1,si_nm,sgg_nm,detail,created_by) VALUES($1,$2,'MANUAL_UNVERIFIED',$3,'Synthetic-si','Synthetic-gu',$4,$5) RETURNING id")
        .bind(org).bind(employee).bind(ROAD).bind(DETAIL).bind(user.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO employee_register_facts(org_id,employee_id,address_id) VALUES($1,$2,$3) ON CONFLICT(org_id,employee_id) DO UPDATE SET address_id=EXCLUDED.address_id")
        .bind(org).bind(employee).bind(address).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO employee_personal_facts(org_id,employee_id,personal_email) VALUES($1,$2,$3) ON CONFLICT(org_id,employee_id) DO UPDATE SET personal_email=EXCLUDED.personal_email")
        .bind(org).bind(employee).bind(EMAIL).execute(pool).await.unwrap();
    (c, id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ordinary_reads_serve_the_reveal_mask(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let root = format!("/api/v1/employees/{id}");
    let (s, detail) = c.call("GET", &root, None).await;
    assert_eq!(s, StatusCode::OK, "{detail}");
    assert_eq!(detail["employment"]["phone_e164"], "010-••••-0000");
    let (s, facts) = c
        .call("GET", &format!("{root}/employment-facts"), None)
        .await;
    assert_eq!(s, StatusCode::OK, "{facts}");
    assert_eq!(facts["birth_date"], "••••-••-••");
    let (s, register) = c.call("GET", &format!("{root}/register-facts"), None).await;
    assert_eq!(s, StatusCode::OK, "{register}");
    assert_eq!(register["address"], "••••");
    let (s, personal) = c.call("GET", &format!("{root}/personal-facts"), None).await;
    assert_eq!(s, StatusCode::OK, "{personal}");
    assert_eq!(personal["personal_email"], "••••");
    for body in [&detail, &facts, &register, &personal] {
        closed(body);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn facts_writes_neither_echo_nor_confirm_a_recorded_birth_date(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let facts = format!("/api/v1/employees/{id}/employment-facts");
    let (_, unchanged) = c.call("PATCH", &facts, Some(json!([]))).await;
    closed(&unchanged);
    // A wrong guess is a conflict whose refusal names only the mask.
    let (s, conflict) = c
        .call("PATCH", &facts, Some(json!([{"op":"test","path":"/birth_date","value":"2000-01-01"},{"op":"replace","path":"/birth_date","value":"2000-01-01"}])))
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{conflict}");
    closed(&conflict);
    // The same value and a different one get the same answer: a recorded birth date changes by correction.
    for guess in [BIRTH, "1991-01-01"] {
        let (s, v) = c
            .call("PATCH", &facts, Some(json!([{"op":"test","path":"/birth_date","value":"••••-••-••"},{"op":"replace","path":"/birth_date","value":guess}])))
            .await;
        assert_eq!(s, StatusCode::CONFLICT, "{guess}: {v}");
        assert_eq!(v["error"]["code"], "correction_required", "{guess}: {v}");
        closed(&v);
    }
    let end = today_kst();
    let (s, v) = c
        .call("PATCH", &facts, Some(json!([{"op":"test","path":"/employment/probation_end_date","value":null},{"op":"replace","path":"/employment/probation_end_date","value":end}])))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    closed(&v);
    let confirm = format!("/api/v1/employees/{id}/probation/confirm");
    let (s, stale) = c
        .call("POST", &confirm, Some(json!({"expected":[{"path":"/employment/probation_end_date","value":end},{"path":"/birth_date","value":"2000-01-01"}]})))
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{stale}");
    closed(&stale);
    let (s, confirmed) = c
        .call(
            "POST",
            &confirm,
            Some(json!({"expected":[{"path":"/employment/probation_end_date","value":end}]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["birth_date"], "••••-••-••");
    closed(&confirmed);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn insurance_filings_say_a_birth_date_is_known_without_carrying_it(pool: PgPool) {
    let (c, _) = person(&pool).await;
    // The hire must fall in the tenant's operating period for its filings to be due.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now()-interval '2 days',go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(c.org).bind(c.user.as_uuid()).execute(&pool).await.unwrap();
    let (s, page) = c
        .call("GET", "/api/v1/statutory/insurance-filings", None)
        .await;
    assert_eq!(s, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    assert!(!items.is_empty(), "{page}");
    assert!(
        items.iter().all(|t| t["birth_date_known"] == true),
        "{page}"
    );
    closed(&page);
    // A known birth date is not restated on a filing, and the refusal is the same for any value.
    let event = items[0]["event_id"].as_str().unwrap();
    let record = format!("/api/v1/statutory/insurance-filings/{event}/ACQUIRE/NPS");
    for guess in [BIRTH, "1991-01-01"] {
        let (s, v) = c
            .call("POST", &record, Some(json!({"expected_version":0,"action":"ASSESS","applicability_facts":{"birth_date":guess}})))
            .await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{guess}: {v}");
        assert_eq!(
            v["error"]["code"], "filing_applicability_unverified",
            "{guess}: {v}"
        );
        closed(&v);
    }
}

const BULK: &str = "/api/v1/employees/corrections/bulk";

fn bulk(id: &str, changes: Value) -> Value {
    json!({"rows":[{"employee_id": id, "changes": changes}], "reason_code": "DATA_ENTRY_ERROR"})
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_preview_and_its_stale_refusal_carry_only_masks(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let body = bulk(
        &id,
        json!({
            "birth_date": "1991-02-03",
            "phone": "010-5555-0001",
            "personal_email": "other@example.invalid",
            "address": {"source":"MANUAL_UNVERIFIED","road_addr_part1":"Synthetic-si Synthetic-gu 9 New-gil","si_nm":"Synthetic-si","sgg_nm":"Synthetic-gu"},
        }),
    );
    let (s, preview) = c
        .call("POST", &format!("{BULK}/preview"), Some(body.clone()))
        .await;
    assert_eq!(s, StatusCode::OK, "{preview}");
    let fields = preview["rows"][0]["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 4, "{preview}");
    assert!(
        fields
            .iter()
            .all(|f| f["before"].as_str().unwrap().contains('•')),
        "{preview}"
    );
    closed(&preview);
    let mut stale = body;
    stale["preview_digest"] = json!("0".repeat(64));
    let (s, refused) = c.call("POST", BULK, Some(stale)).await;
    assert_eq!(s, StatusCode::CONFLICT, "{refused}");
    assert!(refused.to_string().contains("••••-••-••"), "{refused}");
    closed(&refused);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_preview_answers_a_recorded_value_as_any_other(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let answer = |field: &str, value: &str| {
        let body = bulk(&id, json!({ field: value }));
        let c = &c;
        async move {
            let (s, v) = c.call("POST", &format!("{BULK}/preview"), Some(body)).await;
            assert_eq!(s, StatusCode::OK, "{v}");
            let row = &v["rows"][0];
            let f = &row["fields"][0];
            (
                v["counts"].clone(),
                row["outcome"].clone(),
                f["before"].clone(),
                f["path"].clone(),
            )
        }
    };
    for (field, recorded, other) in [
        ("birth_date", BIRTH, "1991-01-01"),
        ("personal_email", EMAIL, "other@example.invalid"),
        ("phone", "010-1234-0000", "010-5555-0001"),
    ] {
        assert_eq!(
            answer(field, recorded).await,
            answer(field, other).await,
            "{field}"
        );
    }
    // A recorded value sent again is written as the single correction writes it.
    let body = bulk(&id, json!({"phone": "010-1234-0000"}));
    let (_, preview) = c
        .call("POST", &format!("{BULK}/preview"), Some(body.clone()))
        .await;
    let mut commit = body;
    commit["preview_digest"] = preview["preview_digest"].clone();
    let (s, done) = c.call("POST", BULK, Some(commit)).await;
    assert_eq!(s, StatusCode::OK, "{done}");
    assert_eq!(done["rows"][0]["applied"], json!(["phone"]), "{done}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_mask_sent_back_is_refused_as_a_value(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let root = format!("/api/v1/employees/{id}");
    let (_, detail) = c.call("GET", &root, None).await;
    let at = detail["employee"]["updated_at"].clone();
    for changes in [
        json!({"phone": "010-••••-0000"}),
        json!({"personal_email": "••••"}),
        // A mask typed around, as an editor opened on it may leave it.
        json!({"personal_email": "••••new@example.invalid"}),
    ] {
        let (s, v) = c
            .call(
                "PATCH",
                &root,
                Some(json!({"expected_updated_at": at, "changes": changes, "reason_code": "QUICK_EDIT"})),
            )
            .await;
        // A validation refusal, not a stale version: the mask is never a value.
        assert!(
            s.is_client_error() && s != StatusCode::CONFLICT,
            "{changes}: {s} {v}"
        );
    }
    let (s, v) = c
        .call(
            "PATCH",
            &root,
            Some(json!({"expected_updated_at": at, "changes": {"phone": "010-5555-0001"}, "reason_code": "QUICK_EDIT"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    closed(&v);
}
