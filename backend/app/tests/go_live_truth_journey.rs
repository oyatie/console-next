#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R2 SETUP: the 운영 시작 preview tells the truth, through the real
//! router as `console_rt`.
//! - company-49 (regression): a 사업장 short of all four 4대보험 counts once,
//!   not once per insurer; no line names the contact store that does not exist.
//! - company-53: every counted line carries the records it counts.
//! - hire-34 (regression): 인원 is who is employed today; 입사 예정 apart.
//! - governance-20: the rail asks for a second passkey until there are two.
//! - routed org changes count the deciders Cedar decides, never a role name.

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use console_platform_test_support::soft_passkey::SoftKey;
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

struct Ctx {
    service: axum::Router,
    token: String,
}

impl Ctx {
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        )
    }

    async fn ok(&self, method: &str, uri: &str, body: Value) -> Value {
        let (status, out) = self.call(method, uri, Some(body)).await;
        assert!(status.is_success(), "{method} {uri}: {status} {out}");
        out
    }

    async fn preview(&self) -> Value {
        let (status, p) = self
            .call("GET", "/api/v1/onboarding/go-live/preview", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{p}");
        p
    }

    async fn step(&self, key: &str) -> Value {
        let (status, rail) = self.call("GET", "/api/v1/onboarding/checklist", None).await;
        assert_eq!(status, StatusCode::OK, "{rail}");
        rail["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
            .cloned()
            .unwrap_or(Value::Null)
    }
}

fn line<'a>(p: &'a Value, list: &str, code: &str) -> &'a Value {
    p[list]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["code"] == code)
        .unwrap_or_else(|| panic!("no {code} in {list}: {p}"))
}

fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "충청북도 청주시 흥덕구 오송읍 오송생명1로 194",
            "si_nm": "충청북도", "sgg_nm": "청주시 흥덕구" })
}

/// A tenant in SETUP with its contracting ops account and passkey.
async fn tenant(pool: &PgPool, routed: bool) -> (Uuid, UserId, SoftKey, Ctx) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '한빛정밀')")
        .bind(org)
        .bind(format!("gt-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active, is_tenant_ops) VALUES ($1, '운영 계정', $2, $3, true, $4)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .bind(!routed)
        .execute(pool)
        .await
        .unwrap();
    if routed {
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) VALUES ($1, 'approval.policy.org_structure', '\"route\"', $2, 'BW01')")
            .bind(org)
            .bind(*admin.as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }
    let passkey = SoftKey::enroll(pool, OrgId::from_uuid(org), admin).await;
    let keys = keys();
    let ctx = Ctx {
        service: build_router(app_state(
            role_pool(pool, "console_rt").await,
            role_pool(pool, "console_leave_cmd").await,
            &keys,
        )),
        token: token(pool, &keys, org, admin).await,
    };
    (org, admin, passkey, ctx)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_go_live_counts_the_records_the_panels_show(pool: PgPool) {
    let (org, admin, _key, ctx) = tenant(&pool, false).await;
    let entity = ctx.ok("POST", "/api/v1/legal-entities", json!({
        "biz_kind": "CORPORATION", "name": "주식회사 한빛정밀", "representation_mode": "SINGLE",
        "representatives": ["홍길동"], "crn": "000211-0006241", "head_office_address": address(),
    })).await;
    let entity = entity["record"]["id"].as_str().unwrap().to_owned();
    let reg = ctx.ok("POST", &format!("/api/v1/legal-entities/{entity}/registrations"), json!({
        "brn": "000-81-00009", "trade_name": "주식회사 한빛정밀", "opened_on": "2020-03-02",
        "business_address": address(), "unit_taxation": false, "tax_office_label": "청주세무서",
        "tax_type": "01", "business_types": [{ "is_main": true, "sector": "제조업", "item": "정밀기기" }],
    })).await;
    let workplaces = format!("/api/v1/legal-entities/{entity}/workplaces");
    let hq = ctx.ok("POST", &workplaces, json!({
        "name": "본사", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
        "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
        "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
    })).await;
    // 오송공장: no 등록증 yet and 4대보험 「아직 없음」 — four insurer rows, one 사업장.
    let osong = ctx.ok("POST", &workplaces, json!({
        "name": "오송공장", "address": address(), "opened_on": "2021-05-03", "kind_code": "FACTORY",
        "insurance": { "shortcut": "NONE_YET" },
    })).await;
    // Departments inherit the nearest SITE's workplace; they need no placement row of their own.
    let department = ctx
        .ok(
            "POST",
            "/api/v1/org-structure/units",
            json!({
                "name": "Human Resources", "workplace_id": hq["record"]["id"],
            }),
        )
        .await;
    ctx.ok(
        "POST",
        "/api/v1/org-structure/units",
        json!({
            "name": "Recruitment", "parent_org_unit_id": department["id"],
        }),
    )
    .await;
    let today = OffsetDateTime::now_utc()
        .to_offset(time::UtcOffset::from_hms(9, 0, 0).unwrap())
        .date();
    let people = [
        (&hq, "본사", today - Duration::days(30)),
        (&osong, "오송공장", today - Duration::days(30)),
        (&hq, "본사", today + Duration::days(12)),
    ];
    for (n, (wp, site, hire)) in people.into_iter().enumerate() {
        let w = &wp["record"];
        let person = ctx.ok("POST", "/api/v1/employees", json!({
            "employee_number": format!("E-00{n}"), "name": format!("직원{n}"), "company": "주식회사 한빛정밀",
            "employment_type": "REGULAR", "phone": format!("010-1234-000{n}"), "position": "사원", "site": site,
            "home_branch_id": w["default_branch_id"], "base_pay": "3000000", "idempotency_key": format!("gt-{n}"),
            "hire_date": hire.to_string(), "org_unit_id": w["org_unit_id"],
        })).await;
        if hire <= today {
            ctx.ok("POST", "/api/v1/employment-assignments", json!({
                "employee_id": person["employee"]["id"], "legal_entity_id": entity, "workplace_id": w["id"], "valid_from": hire.to_string(),
            })).await;
        }
    }

    let p = ctx.preview().await;
    let osong_id = osong["record"]["id"].as_str().unwrap();
    assert_eq!(p["facts"]["org_units"], 2);
    for (id, units) in [
        (entity.as_str(), 2),
        (hq["record"]["id"].as_str().unwrap(), 2),
        (osong["record"]["id"].as_str().unwrap(), 0),
    ] {
        let row = p["breakdown"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap();
        assert_eq!(row["units"], units, "{row}");
    }

    // regression company-49: was 4 (one per insurer).
    let ins = line(&p, "warnings", "insurance_not_established_with_people");
    assert_eq!(ins["count"], 1, "{p}");
    assert_eq!(
        line(&p, "warnings", "insurance_numbers_pending")["count"],
        1,
        "{p}"
    );
    assert!(
        !p.to_string().contains("security_contact_store_pending"),
        "{p}"
    );
    // regression hire-34: was 3 (the 입사 예정 counted in 인원).
    assert_eq!(
        (
            &p["facts"]["employees"],
            &p["facts"]["employees_starting_later"]
        ),
        (&json!(2), &json!(1)),
        "{p}"
    );

    // company-53: the blocker names 오송공장, so its fix opens on that record.
    let staffed = line(&p, "blockers", "staffed_workplace_without_registration");
    assert_eq!(staffed["count"], 1, "{p}");
    assert_eq!(ins["records"][0]["id"], osong_id, "{p}");
    assert_eq!(
        staffed["records"],
        json!([{ "kind": "workplace", "id": osong_id, "name": "오송공장", "legal_entity_id": entity }])
    );
    // governance-20: one passkey → the rail asks for another; never a blocker.
    assert_eq!(
        line(&p, "warnings", "single_passkey")["remedy"],
        "add_passkey"
    );
    assert_eq!(
        ctx.step("people").await,
        Value::Null,
        "no step for the contact store"
    );
    let step = ctx.step("passkey").await;
    assert_eq!(
        (&step["state"], &step["count"]),
        (&json!("todo"), &json!(1)),
        "{step}"
    );
    let _second = SoftKey::enroll(&pool, OrgId::from_uuid(org), admin).await;
    assert_eq!(ctx.step("passkey").await["state"], "done");
    assert!(!ctx.preview().await.to_string().contains("single_passkey"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_routed_org_changes_count_the_deciders_cedar_decides_never_a_role_name(
    pool: PgPool,
) {
    let (org, admin, mut key, ctx) = tenant(&pool, true).await;
    let colleague = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, '김이사', $2, $3, true)")
        .bind(*colleague.as_uuid())
        .bind(["EXECUTIVE"].as_slice())
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    // Two accounts titled SUPER_ADMIN / EXECUTIVE, neither ops nor granted anything: nobody can decide.
    // (The role-name check counted both and asked for nothing.)
    let (status, refused) = ctx
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "forbidden");
    assert_eq!(refused["error"]["reasons"], json!(["tenant_ops_required"]));
    let (phase, events): (String, i64) = sqlx::query_as(
        "SELECT (SELECT phase FROM tenant_phase WHERE org_id = $1), \
         (SELECT count(*) FROM tenant_phase_events WHERE org_id = $1 AND kind = 'GO_LIVE')",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((phase.as_str(), events), ("SETUP", 0));
    let logged: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM audit_events WHERE org_id = $1 AND action = 'tenant.onboarding_refused' AND after_snap->>'code' = 'forbidden')")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert!(logged);

    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(*admin.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let p = ctx.preview().await;
    assert_eq!(
        (
            &p["facts"]["org_change_approvers"],
            &p["facts"]["other_eligible_holders"]
        ),
        (&json!(1), &json!(0)),
        "{p}"
    );
    assert!(!p.to_string().contains("no_org_change_approver"), "{p}");
    assert_eq!(
        line(&p, "warnings", "sole_holder")["remedy"],
        "invite_executive"
    );

    // A tenant role with 조직 결재 over 전체, granted from setup: the colleague now counts.
    let role = ctx.ok("POST", "/api/v1/access/roles", json!({ "name_ko": "조직 결재", "lines": [{ "domain": "org", "levels": ["view", "approve"] }] })).await;
    let op = json!({ "op": "grant", "account_id": colleague.as_uuid(), "role_id": role["id"],
        "scope": { "kind": "TENANT", "node_id": null, "include_descendants": true }, "effective_in_setup": true });
    let preview = ctx
        .ok(
            "POST",
            "/api/v1/access/grants/preview",
            json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": [op] }),
        )
        .await;
    let step_up = key.step_up(&pool).await;
    ctx.ok(
        "POST",
        "/api/v1/access/grants/apply",
        json!({ "receipt_id": preview["receipt_id"], "step_up": step_up }),
    )
    .await;
    let p = ctx.preview().await;
    assert_eq!(
        (
            &p["facts"]["org_change_approvers"],
            &p["facts"]["other_eligible_holders"]
        ),
        (&json!(2), &json!(1)),
        "{p}"
    );
    assert!(!p.to_string().contains("sole_holder"), "{p}");
}

fn keys() -> (String, String) {
    let key = SigningKey::random(&mut OsRng);
    (
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

async fn token(pool: &PgPool, keys: &(String, String), org: Uuid, user: UserId) -> String {
    let settings = JwtSettings {
        issuer: ISSUER.to_owned(),
        audience: AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer = JwtIssuer::from_es256_pem(settings, keys.0.as_bytes(), keys.1.as_bytes()).unwrap();
    let input = AccessTokenInput {
        subject: user,
        org_id: OrgId::from_uuid(org),
        roles: vec!["SUPER_ADMIN".to_owned()],
        branches: Vec::new(),
        platform: false,
        view_as: false,
        read_only: false,
        display_name: None,
        feature_grants: Vec::new(),
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
        issued_at: OffsetDateTime::now_utc(),
    };
    console_platform_test_support::issue_session_token(pool, &issuer, input, None, vec![]).await
}

async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let statement = if role == "console_rt" {
                    "SET ROLE console_rt"
                } else {
                    "SET ROLE console_leave_cmd"
                };
                sqlx::query(statement).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

fn app_state(runtime: PgPool, leave_command: PgPool, keys: &(String, String)) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.0.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
        .unwrap()
}

/// Negative: 운영 시작 is refused while the preview counts a blocker (409 go_live_blocked) or when the digest is not the
/// preview's (409 preview_stale), each with a verified passkey, and nothing is written either time.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_is_refused_with_blockers_open_or_a_stale_digest_and_writes_nothing(pool: PgPool) {
    let (org, _admin, mut key, ctx) = tenant(&pool, false).await;
    let p = ctx.preview().await;
    assert!(!p["blockers"].as_array().unwrap().is_empty(), "{p}");
    let digest = p["digest"].as_str().unwrap().to_owned();
    let go = "/api/v1/onboarding/go-live";
    for (body_digest, code) in [
        ("stale", "preview_stale"),
        (digest.as_str(), "go_live_blocked"),
    ] {
        let step_up = key.step_up(&pool).await;
        let (status, out) = ctx
            .call(
                "POST",
                go,
                Some(json!({ "digest": body_digest, "step_up": step_up })),
            )
            .await;
        assert_eq!(
            (status, &out["error"]["code"]),
            (StatusCode::CONFLICT, &json!(code)),
            "{out}"
        );
    }
    let (phase, events): (String, i64) = sqlx::query_as(
        "SELECT (SELECT phase FROM tenant_phase WHERE org_id = $1), \
         (SELECT count(*) FROM tenant_phase_events WHERE org_id = $1 AND kind = 'GO_LIVE')",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((phase.as_str(), events), ("SETUP", 0));
    assert_eq!(
        ctx.preview().await["digest"],
        json!(digest),
        "a refusal changes nothing the preview reads"
    );
}
