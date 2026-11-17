// SPDX-License-Identifier: LicenseRef-Proprietary
//! Answers that could carry or confirm a governed value: bulk dry runs, a reveal's
//! replay and change requests name it only by its mask.
use super::support::add_user;
use super::*;
use console_hr_adapter_postgres::rrn::reveal_binding;
use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};

const FACTS_BULK: &str = "/api/v1/employees/register-facts/bulk";

fn road(line: &str) -> Value {
    json!({"source":"MANUAL_UNVERIFIED","road_addr_part1":line,"si_nm":"Synthetic-si","sgg_nm":"Synthetic-gu"})
}

async fn register_facts(c: &Ctx, id: &str, dry_run: bool, changes: Value) -> Value {
    let body = json!({"dry_run": dry_run, "reason_code": "DATA_ENTRY_ERROR", "rows": [{"employee_id": id, "changes": changes}]});
    let (s, v) = c.call("POST", FACTS_BULK, Some(body)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_register_facts_dry_run_answers_a_recorded_value_as_any_other(pool: PgPool) {
    let (c, id) = person(&pool).await;
    // Recorded through the same endpoint, so the value sent again is the same value.
    let recorded = road("Synthetic-si Synthetic-gu 1 Recorded-gil");
    register_facts(&c, &id, false, json!({ "address": recorded })).await;
    for (field, same, other) in [
        (
            "address",
            recorded,
            road("Synthetic-si Synthetic-gu 2 Other-gil"),
        ),
        (
            "personal_email",
            json!(EMAIL),
            json!("other@example.invalid"),
        ),
    ] {
        let same = register_facts(&c, &id, true, json!({ field: same })).await;
        let other = register_facts(&c, &id, true, json!({ field: other })).await;
        assert_eq!(same["rows"], other["rows"], "{field}");
        closed(&same);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reveal_is_never_answered_again_from_a_saved_result(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let employee: Uuid = id.parse().unwrap();
    let mut key = SoftKey::enroll(&pool, OrgId::from_uuid(c.org), c.user).await;
    let reason = "IDENTITY_VERIFICATION";
    let binding = reveal_binding(employee, "BIRTH_DATE", reason);
    let start = passkey_service()
        .start_mobile_step_up(&pool, *c.user.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    let step_up = json!({"binding": binding, "assertion": {"ceremony_id": start.ceremony_id, "credential": key.assert(&challenge).unwrap()}});
    let path = format!("/api/v1/employees/{id}/reveal");
    let request = json!({"field": "BIRTH_DATE", "reason_code": reason});
    let mut governed = request.clone();
    governed["step_up"] = step_up;
    let (s, revealed) = c.call("POST", &path, Some(governed)).await;
    assert_eq!(s, StatusCode::OK, "{revealed}");
    assert_eq!(revealed["value"], BIRTH);
    // The same request key without a step-up is not the governed reveal.
    let (s, again) = c.retry("POST", &path, Some(request)).await;
    assert_ne!(s, StatusCode::OK, "{again}");
    closed(&again);
    let (s, lookup) = c
        .call("GET", &format!("/api/v1/requests/{}", c.key.get()), None)
        .await;
    closed(&lookup);
    let kept: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM command_outcomes WHERE org_id=$1 AND result::text LIKE '%' || $2 || '%'",
    )
    .bind(c.org)
    .bind(BIRTH)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, 0, "{s} {lookup}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn change_requests_name_personal_fields_only_by_mask(pool: PgPool) {
    let (c, id) = person(&pool).await;
    let second = add_user(&pool, c.org, &["SUPER_ADMIN"]).await;
    let d = ctx(&pool, c.org, second, &["SUPER_ADMIN"], None).await;
    let (birth, email, line) = (
        "1991-02-03",
        "moved@example.invalid",
        "Synthetic-si Synthetic-gu 3 Moved-gil",
    );
    let proposed = |v: &Value| {
        closed(v);
        let text = v.to_string();
        for clear in [birth, email, line, "5555-0001", "55550001"] {
            assert!(!text.contains(clear), "{clear} in {text}");
        }
    };
    let changes = json!({"birth_date": birth, "phone": "010-5555-0001", "personal_email": email, "address": road(line)});
    let (s, filed) = c
        .call(
            "POST",
            "/api/v1/change-requests",
            Some(
                json!({"kind":"PROFILE_CORRECTION","subject_type":"EMPLOYEE","subject_id":id,
                "payload":{"changes":changes},"reason_code":"DATA_ENTRY_ERROR"}),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{filed}");
    proposed(&filed);
    assert_eq!(filed["payload"]["changes"]["birth_date"], "••••-••-••");
    assert_eq!(filed["payload"]["changes"]["phone"], "010-••••-0001");
    let (s, list) = d.call("GET", "/api/v1/change-requests", None).await;
    assert_eq!(s, StatusCode::OK, "{list}");
    proposed(&list);
    let request = filed["id"].as_str().unwrap();
    let (s, applied) = d
        .call(
            "POST",
            &format!("/api/v1/change-requests/{request}/decide"),
            Some(json!({"decision":"APPLY","reason_code":"CONFIRMED"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{applied}");
    proposed(&applied);
    let (s, list) = c.call("GET", "/api/v1/change-requests", None).await;
    assert_eq!(s, StatusCode::OK, "{list}");
    proposed(&list);
    // The second person applied the values filed, never their masks.
    let stored: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT e.birth_date::text, f.personal_email FROM person_employees_current e \
         LEFT JOIN employee_personal_facts f ON f.org_id=e.org_id AND f.employee_id=e.id WHERE e.id=$1",
    )
    .bind(id.parse::<Uuid>().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, (Some(birth.into()), Some(email.into())));
}
