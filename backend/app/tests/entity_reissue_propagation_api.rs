#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 등록증 재발급·정정 propagation through the real router: one evidenced change, a change dated before the state in force, the holder 사업장.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, add_user, ctx, structure, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const BUSAN: &str = "부산광역시 해운대구 센텀중앙로 79";
const DAEJEON: &str = "대전광역시 유성구 대학로 99";

async fn upload(c: &Ctx, tag: &str) -> Uuid {
    let b = "reissueboundary";
    let body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nBIZ_REG_CERT\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cert-{tag}.pdf\"\r\n\
         Content-Type: application/pdf\r\n\r\n%PDF-1.7 {tag}\r\n--{b}--\r\n"
    );
    let (status, doc) = c
        .raw(
            "POST",
            "/api/v1/entity-documents",
            &format!("multipart/form-data; boundary={b}"),
            Some(body.into_bytes()),
            Some(Uuid::new_v4()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{doc}");
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn addr(road: &str) -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": road, "si_nm": "부산광역시", "sgg_nm": "해운대구" })
}

async fn entity(c: &Ctx, id: &str) -> Value {
    let (status, e) = c
        .call("GET", &format!("/api/v1/legal-entities/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    e
}

/// The reissue body as the sheet sends it: the registration's full state with
/// the new 소재지, and (optionally) the 법인's with a new 대표자.
fn body(e: &Value, doc: Uuid, reason: &str, from: &str, road: &str, reps: Option<&str>) -> Value {
    let r = &e["registrations"][0];
    let cur = &r["current"];
    let mut v = json!({
        "document_id": doc, "reason": reason, "effective_from": from,
        "registration": {
            "expected_version": cur["version"], "brn": support::STRUCTURE_BRN, "trade_name": "주식회사 가나",
            "opened_on": "2020-03-02", "business_address": addr(road), "unit_taxation": false,
            "tax_office_label": "삼성세무서", "tax_type": "01", "cert_issued_on": from,
            "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
            "status": "CONTINUING",
        },
    });
    if let Some(rep) = reps {
        let ec = &e["current"];
        v["entity"] = json!({
            "expected_version": ec["version"], "biz_kind": "CORPORATION", "name": "주식회사 가나",
            "representation_mode": "SINGLE", "representatives": [rep], "crn": "000211-0006241",
            "head_office_address": support::address(),
        });
    }
    v
}

fn road(e: &Value) -> String {
    e["registrations"][0]["current"]["business_address"]["road_addr_part1"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

async fn reg_revisions(pool: &PgPool, reg: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1",
    )
    .bind(Uuid::parse_str(reg).unwrap())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn setup(pool: &PgPool) -> (Ctx, String, String, String) {
    let (org, owner) = tenant(pool, ADMIN).await;
    let c = ctx(pool, org, owner, ADMIN, None).await;
    let (entity_id, wp, _, _) = structure(&c).await;
    let e = entity(&c, &entity_id).await;
    let reg = e["registrations"][0]["id"].as_str().unwrap().to_owned();
    (c, entity_id, reg, wp)
}

/// Fails on dev (no reissue route). A new certificate moving 소재지 and
/// changing 대표자 is one evidenced, replay-safe change; the certificate in
/// force cannot be named again; the next one supersedes it.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reissue_is_one_evidenced_change_and_supersedes_the_previous(pool: PgPool) {
    let (c, id, reg, _) = setup(&pool).await;
    let uri = format!("/api/v1/business-registrations/{reg}/reissues");
    let a = upload(&c, "a").await;
    let e = entity(&c, &id).await;
    let first = body(
        &e,
        a,
        "CERT_CHANGE_REPORT",
        "2026-10-01",
        BUSAN,
        Some("김대표"),
    );
    let (status, v) = c.call("POST", &uri, Some(first.clone())).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let n = reg_revisions(&pool, &reg).await;
    // A replay never reapplies: the stored result (200) or, with none kept, 409 command_applied.
    let (status, again) = c.retry("POST", &uri, Some(first)).await;
    assert!(
        status == StatusCode::OK
            || (status == StatusCode::CONFLICT && again["error"]["code"] == "command_applied"),
        "{status} {again}"
    );
    assert_eq!(
        reg_revisions(&pool, &reg).await,
        n,
        "a retry writes nothing"
    );

    let e = entity(&c, &id).await;
    assert_eq!(road(&e), BUSAN);
    assert_eq!(
        e["current"]["representatives"],
        json!(["김대표"]),
        "{}",
        e["current"]
    );
    let (status, h) = c
        .call(
            "GET",
            &format!("/api/v1/business-registrations/{reg}/revisions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{h}");
    let items = h["items"]
        .as_array()
        .or_else(|| h.as_array())
        .unwrap()
        .clone();
    let cited: Vec<_> = items
        .iter()
        .filter(|x| x["evidence_document_id"] == json!(a))
        .collect();
    assert_eq!(cited.len(), 1, "{h}");
    assert_eq!(cited[0]["reason_code"], "CERT_CHANGE_REPORT");

    // The certificate in force named again: refused, nothing written.
    let e = entity(&c, &id).await;
    let (status, v) = c
        .call(
            "POST",
            &uri,
            Some(body(&e, a, "CERT_REISSUE", "2026-10-02", BUSAN, None)),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["error"]["errors"][0]["code"], "document_not_new", "{v}");
    assert_eq!(reg_revisions(&pool, &reg).await, n);

    let b = upload(&c, "b").await;
    let (status, v) = c
        .call(
            "POST",
            &uri,
            Some(body(&e, b, "CERT_REISSUE", "2026-10-02", BUSAN, None)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let (status, docs) = c
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{id}/documents"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{docs}");
    let docs = docs["items"].as_array().unwrap().clone();
    let of = |d: Uuid| docs.iter().find(|x| x["id"] == json!(d)).unwrap().clone();
    assert!(of(a)["superseded_at"].is_string(), "{docs:?}");
    assert!(of(b)["superseded_at"].is_null(), "{docs:?}");
    assert_eq!(of(b)["registration_id"], json!(reg));

    // The 법인 guard: a MEMBER may not.
    let member = add_user(&pool, c.org, &["MEMBER"]).await;
    let m = ctx(&pool, c.org, member, &["MEMBER"], None).await;
    let x = upload(&c, "x").await;
    let e = entity(&c, &id).await;
    let (status, v) = m
        .call(
            "POST",
            &uri,
            Some(body(&e, x, "CERT_REISSUE", "2026-10-03", BUSAN, None)),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{v}");
}

/// Adversarial: a 정정 신고 dated before the certificate state in force. The
/// sheet refuses that date (beforeInForce); so does the server, on
/// effective_from, writing nothing — never a change no surface shows while its
/// certificate becomes the one in force.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_dated_before_the_state_in_force_is_never_silently_lost(pool: PgPool) {
    let (c, id, reg, _) = setup(&pool).await;
    let uri = format!("/api/v1/business-registrations/{reg}/reissues");
    let a = upload(&c, "a").await;
    let e = entity(&c, &id).await;
    let (status, v) = c
        .call(
            "POST",
            &uri,
            Some(body(&e, a, "CERT_CHANGE_REPORT", "2026-10-01", BUSAN, None)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let b = upload(&c, "b").await;
    let e = entity(&c, &id).await;
    let (status, v) = c
        .call(
            "POST",
            &uri,
            Some(body(
                &e,
                b,
                "CERT_CHANGE_REPORT",
                "2025-01-01",
                DAEJEON,
                None,
            )),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["error"]["errors"][0]["field"], "effective_from", "{v}");
    assert_eq!(
        v["error"]["errors"][0]["code"], "before_state_in_force",
        "{v}"
    );
    let e = entity(&c, &id).await;
    assert_eq!(road(&e), BUSAN, "nothing written");
    let (status, docs) = c
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{id}/documents"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{docs}");
    assert!(
        docs["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["id"] != json!(b)),
        "the refused certificate is not attached: {docs}"
    );
}

/// Probe (every surface derives, §13.18): the 사업장 that holds the
/// certificate with 「등록증과 같음」 shows the certificate's 소재지 after it moved.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
#[ignore = "ss-003-address-link: 등록증과 같음 stores a copy of the address id; lands with the link (no copy-propagation patch)"]
async fn the_holder_workplace_shows_the_moved_address(pool: PgPool) {
    let (c, id, reg, wp) = setup(&pool).await;
    let uri = format!("/api/v1/business-registrations/{reg}/reissues");
    let a = upload(&c, "a").await;
    let e = entity(&c, &id).await;
    let (status, v) = c
        .call(
            "POST",
            &uri,
            Some(body(&e, a, "CERT_CHANGE_REPORT", "2026-10-01", BUSAN, None)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let e = entity(&c, &id).await;
    let w = e["workplaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == json!(wp))
        .unwrap()
        .clone();
    assert_eq!(
        w["current"]["address"]["road_addr_part1"],
        json!(BUSAN),
        "the 사업장 panel's 소재지: {}",
        w["current"]["address"]
    );
}
