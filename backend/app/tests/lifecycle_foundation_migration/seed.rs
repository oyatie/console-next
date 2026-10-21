//! The API-only seed of the LC migration test: two 법인 and five people, an
//! exit and a rehire, a 전적, a live exit and a withdrawn one.

#[path = "../support/go_live.rs"]
mod go_live;
#[path = "../emp_ui_routes/harness.rs"]
mod harness;

#[path = "../support/terms.rs"]
mod terms;

use harness::{Caller, keys, router, token, user};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

pub fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

pub fn day(offset: i64) -> String {
    (today() + Duration::days(offset)).to_string()
}

fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

async fn ok(caller: &Caller, method: &str, uri: &str, body: Value) -> Value {
    let (status, out) = caller.call(method, uri, Some(body)).await;
    assert!(status.is_success(), "{method} {uri}: {status} {out}");
    out
}

/// A 법인 with its 사업자등록 and 본사; (entity, workplace, branch, org unit).
async fn entity(
    ops: &Caller,
    name: &str,
    crn: &str,
    brn: &str,
) -> (String, String, String, String) {
    let e = ok(
        ops,
        "POST",
        "/api/v1/legal-entities",
        json!({
            "biz_kind": "CORPORATION", "name": name, "representation_mode": "SINGLE",
            "representatives": ["홍길동"], "crn": crn, "head_office_address": address(),
        }),
    )
    .await;
    let id = e["record"]["id"].as_str().unwrap().to_owned();
    let reg = ok(ops, "POST", &format!("/api/v1/legal-entities/{id}/registrations"), json!({
        "brn": brn, "trade_name": name, "opened_on": "2020-03-02", "business_address": address(),
        "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01",
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
    }))
    .await;
    let wp = ok(ops, "POST", &format!("/api/v1/legal-entities/{id}/workplaces"), json!({
        "name": "본사", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
        "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
        "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
    }))
    .await;
    let r = &wp["record"];
    let s = |k: &str| r[k].as_str().unwrap().to_owned();
    (id, s("id"), s("default_branch_id"), s("org_unit_id"))
}

struct Place {
    entity: String,
    workplace: String,
    branch: String,
    unit: String,
    company: &'static str,
}

/// Registers a person and binds them to the 법인 from their hire date.
async fn hire(ops: &Caller, at: &Place, number: &str, name: &str, hired: &str) -> Uuid {
    let created = ok(ops, "POST", "/api/v1/employees", json!({
        "employee_number": number, "name": name, "company": at.company, "employment_type": "REGULAR",
        "phone": "010-1234-5678", "position": "사원", "site": "본사", "home_branch_id": at.branch,
        "base_pay": "3000000", "idempotency_key": format!("lc-{number}"), "hire_date": hired,
        "org_unit_id": at.unit,
    }))
    .await;
    let id = created["employee"]["id"].as_str().unwrap().to_owned();
    ok(ops, "POST", "/api/v1/employment-assignments", json!({
        "employee_id": id, "legal_entity_id": at.entity, "workplace_id": at.workplace, "valid_from": hired,
    }))
    .await;
    id.parse().unwrap()
}

async fn report_exit(ops: &Caller, employee: Uuid, on: &str) -> String {
    let case = ok(
        ops,
        "POST",
        "/api/v1/hr/exit-cases",
        json!({
            "employee_id": employee, "effective_exit_date": on, "site_manager_note": "퇴직 보고",
            "exit_reason_code": "PERSONAL",
        }),
    )
    .await;
    case["id"].as_str().unwrap().to_owned()
}

/// What the seed made, by role.
pub struct Seeded {
    pub org: Uuid,
    pub entity_a: String,
    pub entity_b: String,
    pub plain: Uuid,
    pub rehired: Uuid,
    pub moved: Uuid,
    /// The confirmed exit of `rehired`, the live one and the withdrawn one.
    pub exit: String,
    pub live: String,
    pub withdrawn: String,
}

pub async fn seed(pool: &PgPool) -> Seeded {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'LC 이관')")
        .bind(org)
        .bind(format!("lc-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let keys = keys();
    let ops_id = user(pool, org, "SUPER_ADMIN").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(ops_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let ops = Caller {
        service: router(pool, &keys).await,
        token: Some(token(pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };

    // SETUP: two 법인 and five people, through the API only.
    let (status, _) = ops
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(terms::publish(pool).await),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (ea, wa, ba, ua) = entity(&ops, "주식회사 가나", "000211-0006241", "000-81-00009").await;
    let (eb, wb, _, _) = entity(&ops, "주식회사 다라", "000000-1000033", "000-81-00066").await;
    let a = Place {
        entity: ea.clone(),
        workplace: wa,
        branch: ba,
        unit: ua.clone(),
        company: "주식회사 가나",
    };
    let plain = hire(&ops, &a, "LC-1", "정재직", "2025-03-03").await;
    let rehired = hire(&ops, &a, "LC-2", "재입사", "2025-01-02").await;
    let moved = hire(&ops, &a, "LC-3", "전적자", "2024-07-01").await;
    let leaving = hire(&ops, &a, "LC-4", "퇴직예정", "2025-05-02").await;
    let stays = hire(&ops, &a, "LC-5", "철회", "2025-06-02").await;
    go_live::go_live(pool, org).await;

    // 퇴직 → 재입사: HR confirmation exits now (TERMINATE), the rehire opens a new period.
    let exit = report_exit(&ops, rehired, &day(-10)).await;
    ok(
        &ops,
        "POST",
        &format!("/api/v1/hr/exit-cases/{exit}/confirm"),
        json!({ "signoffs": {
        "privacy_notice_ack": true, "korean_labor_law_ack": true,
        "payroll_cutoff_ack": true, "retirement_settlement_ack": true } }),
    )
    .await;
    ok(&ops, "POST", &format!("/api/v1/employees/{rehired}/rehire"), json!({
        "hire_date": day(-3), "employment_type": "REGULAR", "org_unit_id": ua, "position": "사원",
        "idempotency_key": "lc-rehire",
    }))
    .await;
    // 전적 A → B, settled.
    ok(
        &ops,
        "POST",
        &format!("/api/v1/employees/{moved}/lifecycle-events"),
        json!({
            "event_type": "GROUP_TRANSFER", "effective_date": day(-2), "comment": "전적",
            "to_workplace_id": wb, "group_transfer": {
                "continuity": "SETTLED", "group_service_start_date": "2024-07-01",
                "consent_date": day(-12), "consent_evidence_ref": "전적 동의서" },
        }),
    )
    .await;
    // A live exit (reported, future date) and a withdrawn one.
    let live = report_exit(&ops, leaving, &day(5)).await;
    let withdrawn = report_exit(&ops, stays, &day(3)).await;
    ok(
        &ops,
        "POST",
        &format!("/api/v1/hr/exit-cases/{withdrawn}/cancel"),
        json!({ "reason": "철회" }),
    )
    .await;
    Seeded {
        org,
        entity_a: ea,
        entity_b: eb,
        plain,
        rehired,
        moved,
        exit,
        live,
        withdrawn,
    }
}
