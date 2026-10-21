#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Verify #2 regression (red on 922cda41b): a reissue changing 대표자 while a later 법인 state is
//! scheduled must not undo that scheduled change (the 법인 part was clamped to
//! the later date, but built on the state in force today, as the sheet sends it).
//! Refused on effective_from, nothing written; the same for a scheduled registration state.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, address, ctx, structure, tenant, today_kst};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const DAEJEON: &str = "대전광역시 유성구 대학로 99";

async fn upload(c: &Ctx, tag: &str) -> Uuid {
    let b = "vhboundary";
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

async fn entity(c: &Ctx, id: &str) -> Value {
    let (status, e) = c
        .call("GET", &format!("/api/v1/legal-entities/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    e
}

async fn document_attached(c: &Ctx, entity_id: &str, doc: Uuid) -> bool {
    let (status, docs) = c
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity_id}/documents"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{docs}");
    docs["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["id"] == json!(doc))
}

async fn plus_days(pool: &PgPool, d: &str, n: i32) -> String {
    sqlx::query_scalar("SELECT ($1::date + $2)::text")
        .bind(d)
        .bind(n)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn head_office_on(pool: &PgPool, entity: &str, on: &str) -> (String, i32) {
    let (road, version): (Option<String>, i32) = sqlx::query_as(
        "SELECT a.road_addr_part1, r.version FROM legal_entity_revisions r \
           LEFT JOIN entity_addresses a ON a.id = r.head_office_address_id \
         WHERE r.legal_entity_id = $1 AND r.effective_from <= $2::date \
         ORDER BY r.effective_from DESC, r.version DESC LIMIT 1",
    )
    .bind(Uuid::parse_str(entity).unwrap())
    .bind(on)
    .fetch_one(pool)
    .await
    .unwrap();
    (road.unwrap_or_default(), version)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reissue_never_undoes_a_scheduled_entity_change(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let c = ctx(&pool, org, owner, ADMIN, None).await;
    let (id, _, _, _) = structure(&c).await;
    let today = today_kst();
    let later = plus_days(&pool, &today, 30).await;
    let e = entity(&c, &id).await;
    let mut moved = address();
    moved["road_addr_part1"] = json!(DAEJEON);
    let (status, v) = c
        .call("PUT", &format!("/api/v1/legal-entities/{id}"), Some(json!({
            "expected_version": e["current"]["version"], "effective_from": later, "reason_code": "REV",
            "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
            "representatives": ["홍길동"], "crn": "000211-0006241", "head_office_address": moved,
        })))
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        head_office_on(&pool, &id, &later).await.0,
        DAEJEON,
        "the move is scheduled"
    );

    // The sheet's body: the 법인 part built on the state in force on the change date (today), its
    // expected_version the newest read (the scheduled one), the registration's state as it is.
    let e = entity(&c, &id).await;
    let newest = e["scheduled"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["version"].as_i64().unwrap())
        .max()
        .unwrap();
    let r = &e["registrations"][0];
    let reg = r["id"].as_str().unwrap().to_owned();
    let doc = upload(&c, "v2").await;
    let body = json!({
        "document_id": doc, "reason": "CERT_CHANGE_REPORT", "effective_from": today,
        "registration": {
            "expected_version": r["current"]["version"], "brn": support::STRUCTURE_BRN, "trade_name": "주식회사 가나",
            "opened_on": "2020-03-02", "business_address": address(), "unit_taxation": false,
            "tax_office_label": "삼성세무서", "tax_type": "01", "cert_issued_on": today,
            "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
            "status": "CONTINUING",
        },
        "entity": {
            "expected_version": newest, "biz_kind": "CORPORATION", "name": "주식회사 가나",
            "representation_mode": "SINGLE", "representatives": ["김대표"], "crn": "000211-0006241",
            "head_office_address": address(),
        },
    });
    let (status, v) = c
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg}/reissues"),
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["error"]["errors"][0]["field"], "effective_from", "{v}");
    assert_eq!(
        v["error"]["errors"][0]["code"], "entity_change_scheduled",
        "{v}"
    );
    let (road, version) = head_office_on(&pool, &id, &later).await;
    assert_eq!(road, DAEJEON, "the scheduled 본점 move stands");
    assert_eq!(version, i32::try_from(newest).unwrap(), "nothing written");
    let after = entity(&c, &id).await;
    assert_eq!(
        after["registrations"][0]["current"]["version"], r["current"]["version"],
        "nothing written"
    );
    assert!(
        !document_attached(&c, &id, doc).await,
        "the refused certificate is not attached"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reissue_is_refused_under_a_scheduled_registration_state(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let c = ctx(&pool, org, owner, ADMIN, None).await;
    let (id, _, _, _) = structure(&c).await;
    let today = today_kst();
    let later = plus_days(&pool, &today, 30).await;
    let e = entity(&c, &id).await;
    let r = &e["registrations"][0];
    let reg = r["id"].as_str().unwrap().to_owned();
    let mut moved = address();
    moved["road_addr_part1"] = json!(DAEJEON);
    let state = |from: &str, version: &Value, at: Value| {
        json!({
            "expected_version": version, "brn": support::STRUCTURE_BRN, "trade_name": "주식회사 가나",
            "opened_on": "2020-03-02", "business_address": at, "unit_taxation": false,
            "tax_office_label": "삼성세무서", "tax_type": "01", "cert_issued_on": from,
            "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
            "status": "CONTINUING",
        })
    };
    let mut scheduled = state("2020-03-02", &r["current"]["version"], moved);
    scheduled["effective_from"] = json!(later);
    scheduled["reason_code"] = json!("REV");
    let (status, v) = c
        .call(
            "PUT",
            &format!("/api/v1/business-registrations/{reg}"),
            Some(scheduled),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let newest = json!(r["current"]["version"].as_i64().unwrap() + 1);
    let doc = upload(&c, "v2").await;
    let body = json!({
        "document_id": doc, "reason": "CERT_CHANGE_REPORT", "effective_from": today,
        "registration": state(&today, &newest, address()),
    });
    let (status, v) = c
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg}/reissues"),
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(
        v["error"]["errors"][0]["code"], "registration_change_scheduled",
        "{v}"
    );
    let after = entity(&c, &id).await;
    assert_eq!(
        after["registrations"][0]["current"]["version"], r["current"]["version"],
        "the registration in force is unchanged"
    );
    let stored: (i32, String) = sqlx::query_as(
        "SELECT version, effective_from::text FROM business_registration_revisions \
         WHERE registration_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        stored,
        (i32::try_from(newest.as_i64().unwrap()).unwrap(), later),
        "the scheduled registration remains intact"
    );
    assert!(
        !document_attached(&c, &id, doc).await,
        "the refused certificate is not attached"
    );
}
