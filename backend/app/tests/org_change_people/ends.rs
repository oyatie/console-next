//! UX-R3 STRUCT (company-01/02, move-02, records-04): one headcount rule. A
//! confirmed exit ends the person's assignment the day after the 마지막
//! 근무일 and every 사업장 · 법인 count drops them (the 법인 list, record and
//! close sheet read these; the close itself is entity-ops' and the E2E's).
//! Withdrawing the exit reopens the assignment.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::fixture::{HIRE, Tenant, day, tenant};

const EXITS: &str = "/api/v1/hr/exit-cases";

/// Reports and HR-confirms `employee`'s exit with `last_day`; returns the case id.
async fn exit(t: &Tenant, employee: Uuid, last_day: &str) -> String {
    let body = json!({
        "employee_id": employee, "effective_exit_date": last_day,
        "site_manager_note": "개인 사정", "exit_reason_code": "PERSONAL",
    });
    let (status, case) = t.ops.call("POST", EXITS, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "report: {case}");
    let id = case["id"].as_str().unwrap().to_owned();
    let signoffs = json!({ "signoffs": {
        "privacy_notice_ack": true, "korean_labor_law_ack": true,
        "payroll_cutoff_ack": true, "retirement_settlement_ack": true,
    } });
    let (status, confirmed) = t
        .ops
        .call("POST", &format!("{EXITS}/{id}/confirm"), Some(signoffs))
        .await;
    assert_eq!(status, StatusCode::OK, "confirm: {confirmed}");
    id
}

/// `(entity, [본사, 판교])` headcounts on /org-structure.
async fn chart(t: &Tenant) -> (i64, Vec<i64>) {
    let (status, s) = t.ops.call("GET", "/api/v1/org-structure", None).await;
    assert_eq!(status, StatusCode::OK, "{s}");
    let e = s["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == json!(t.entity))
        .unwrap();
    let wps = t.workplaces.iter().map(|w| {
        e["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == json!(w))
            .unwrap()["headcount"]
            .as_i64()
            .unwrap()
    });
    (e["headcount"].as_i64().unwrap(), wps.collect())
}

/// The 법인 record's [본사, 판교] headcounts (the 법인 list, the record and the close sheet read these).
async fn record(t: &Tenant) -> Vec<i64> {
    let (status, e) = t
        .ops
        .call("GET", &format!("/api/v1/legal-entities/{}", t.entity), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    let wps = e["workplaces"].as_array().unwrap();
    let of = |id: &Uuid| {
        wps.iter().find(|w| w["id"] == json!(id)).unwrap()["headcount"]
            .as_i64()
            .unwrap()
    };
    t.workplaces.iter().map(of).collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_an_exited_person_leaves_every_count(pool: PgPool) {
    // regression: r3 company-01 (P0) — HR- and HQ-confirmed, still 「재직자 1명」; the close never opened.
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let leaver = t.person("떠날사람", t.sites[1], pangyo, "ACTIVE").await;
    assert_eq!(chart(&t).await, (1, vec![0, 1]));
    assert_eq!(record(&t).await, [0, 1]);
    exit(&t, leaver, &day(-1)).await;
    // The exit ended the assignment the day after the 마지막 근무일.
    assert_eq!(
        t.live(leaver).await,
        [(HIRE.to_owned(), Some(day(0)), pangyo, "HIRE".to_owned())]
    );
    assert_eq!(chart(&t).await, (0, vec![0, 0]), "the chart drops them");
    assert_eq!(
        record(&t).await,
        [0, 0],
        "the 법인 record (list, close sheet) drops them"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_same_day_exit_leaves_every_count_at_once(pool: PgPool) {
    // regression: r3 records-04 — 마지막 근무일 today: the 부서 dropped them, the 사업장 and 법인 did not.
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let sales = t.dept("영업팀", t.sites[1]).await;
    let leaver = t.person("오늘퇴직", sales, pangyo, "ACTIVE").await;
    t.person("남는사람", sales, pangyo, "ACTIVE").await;
    exit(&t, leaver, &day(0)).await;
    assert_eq!(
        t.live(leaver).await[0].1,
        Some(day(1)),
        "the row ends after the last working day"
    );
    // 부서 1 = 사업장 1 = 법인 1: the numbers add up on the same day.
    let (status, s) = t.ops.call("GET", "/api/v1/org-structure", None).await;
    assert_eq!(status, StatusCode::OK);
    let text = s.to_string();
    assert!(text.contains("\"direct_headcount\":1,"), "{text}");
    assert_eq!(chart(&t).await, (1, vec![0, 1]));
    assert_eq!(record(&t).await, [0, 1]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cancelling_a_confirmed_exit_reopens_the_assignment(pool: PgPool) {
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let stays = t.person("돌아온사람", t.sites[1], pangyo, "ACTIVE").await;
    let case = exit(&t, stays, &day(-1)).await;
    let (status, body) = t
        .ops
        .call(
            "POST",
            &format!("{EXITS}/{case}/cancel"),
            Some(json!({ "reason": "잘못 보고" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        t.live(stays).await,
        [(HIRE.to_owned(), None, pangyo, "HIRE".to_owned())]
    );
    assert_eq!(chart(&t).await, (1, vec![0, 1]));
}
