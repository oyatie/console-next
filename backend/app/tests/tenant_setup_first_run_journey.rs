#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The solo first run, end to end through the real router as `console_rt`,
//! with ONE person and no helper account (walk.md §0.1 dead end):
//! 이용약관 → 법인 → 사업자등록 → 사업장 → 부서 (no approval) → 직원 →
//! 운영 시작 (preview digest + passkey step-up, Cedar + Rust backstop), then
//! the setup-only acts are refused with their remedy, and an org change
//! applies at submit with no approval step (decisions #26).

#[path = "support/terms.rs"]
mod terms;

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

#[path = "tenant_setup_first_run_journey/labels.rs"]
mod labels;
use labels::{structure_label_routes, workplace_kind_routes};

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

struct Ctx {
    service: axum::Router,
    token: String,
    key: std::cell::Cell<Uuid>,
}

impl Ctx {
    /// One user intent: a fresh Idempotency-Key.
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.key.set(Uuid::new_v4());
        self.send(method, uri, body, Some(self.key.get())).await
    }

    /// The previous call's retry: the same Idempotency-Key.
    async fn retry(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send(method, uri, body, Some(self.key.get())).await
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        body: Option<Value>,
        key: Option<Uuid>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(key) = key {
            builder = builder.header("Idempotency-Key", key.to_string());
        }
        let request = builder
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
}

fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_person_goes_from_an_empty_tenant_to_operating(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("fr-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active, is_tenant_ops) VALUES ($1, '대표', $2, $3, true, true)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let mut passkey = SoftKey::enroll(&pool, OrgId::from_uuid(org), admin).await;
    let keys = keys();
    let ctx = Ctx {
        service: build_router(app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            &keys,
        )),
        token: token(&pool, &keys, org, admin).await,
        key: std::cell::Cell::new(Uuid::nil()),
    };

    let (status, rail) = ctx.call("GET", "/api/v1/onboarding/checklist", None).await;
    assert_eq!(status, StatusCode::OK, "{rail}");
    assert_eq!(rail["phase"], "SETUP");
    assert_eq!(rail["steps"][0]["key"], "entity");
    assert_eq!(rail["steps"][1]["state"], "blocked");
    assert_eq!(rail["steps"][1]["remedy"], "create_legal_entity");
    // regression (W10): no 결재선 step while approval.policy.org_structure = none.
    assert!(!rail.to_string().contains("\"approval\""), "{rail}");

    let (status, _) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(terms::publish(&pool).await),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let first_entity = json!({
        "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
        "representatives": ["홍길동"], "crn": "000211-0006241", "head_office_address": address(),
    });
    let (status, entity) = ctx
        .call("POST", "/api/v1/legal-entities", Some(first_entity.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    assert_eq!(entity["change_mode"], "SETUP");
    let entity_id = entity["record"]["id"].as_str().unwrap().to_owned();
    // A lost response retried with the same key replays, never duplicates.
    let (status, replay) = ctx
        .retry("POST", "/api/v1/legal-entities", Some(first_entity.clone()))
        .await;
    assert_eq!(
        (status, &replay["record"]["id"]),
        (StatusCode::CREATED, &entity["record"]["id"])
    );
    let (status, keyless) = ctx
        .send("POST", "/api/v1/legal-entities", Some(first_entity), None)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{keyless}");
    assert_eq!(keyless["error"]["errors"][0]["field"], "Idempotency-Key");

    let (status, refused) = ctx
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(json!({ "name": "x", "crn": "12" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert!(
        refused["error"]["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["field"] == "biz_kind" && e["code"] == "required")
    );

    let (status, reg) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/registrations"), Some(json!({
            "brn": "000-81-00009", "trade_name": "주식회사 가나", "opened_on": "2020-03-02",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서",
            "tax_type": "01", "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    assert_eq!(reg["record"]["brn"]["display"], "000-81-00009");

    let (status, wp) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/workplaces"), Some(json!({
            "name": "본사", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
            "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
            "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{wp}");
    assert_eq!(wp["record"]["kind_code"], "HEAD_OFFICE", "{wp}");
    let workplace_id = wp["record"]["id"].as_str().unwrap().to_owned();
    let branch = wp["record"]["default_branch_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // A department applies immediately in SETUP: no proposal, no second person.
    let (status, unit) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({ "kind": "DEPARTMENT", "name": "영업팀", "workplace_id": workplace_id })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{unit}");
    let dept = unit["id"].as_str().unwrap().to_owned();
    let (status, direct) = ctx
        .call("POST", "/api/v1/employees", Some(json!({
            "employee_number": "E-000", "name": "이현장", "company": "주식회사 가나", "employment_type": "REGULAR",
            "phone": "010-1234-0000", "position": "사원", "site": "본사", "home_branch_id": branch,
            "base_pay": "3000000", "idempotency_key": "fr-emp-0", "hire_date": "2026-01-02", "org_unit_id": dept,
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{direct}");
    let (status, bound) = ctx
        .call("POST", "/api/v1/employment-assignments", Some(json!({
            "employee_id": direct["employee"]["id"], "legal_entity_id": entity_id, "workplace_id": workplace_id, "valid_from": "2026-01-02",
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{bound}");

    let (_, tree) = ctx.call("GET", "/api/v1/org-structure", None).await;
    assert_eq!(
        tree["entities"][0]["children"][0]["children"][0]["name"], "영업팀",
        "{tree}"
    );
    org_setup_routes(&ctx, &dept, &tree).await;
    workplace_kind_routes(&ctx, &workplace_id).await;
    structure_label_routes(&ctx, &workplace_id).await;

    let (status, created) = ctx
        .call("POST", "/api/v1/employees", Some(json!({
            "employee_number": "E-001", "name": "김직원", "company": "주식회사 가나", "employment_type": "REGULAR",
            "phone": "010-1234-5678", "position": "사원", "site": "본사", "home_branch_id": branch,
            "base_pay": "3000000", "idempotency_key": "fr-emp-1", "hire_date": "2026-01-02", "org_unit_id": dept,
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let employee = created["employee"]["id"].as_str().unwrap().to_owned();
    let (status, bound) = ctx
        .call("POST", "/api/v1/employment-assignments", Some(json!({
            "employee_id": employee, "legal_entity_id": entity_id, "workplace_id": workplace_id, "valid_from": "2026-01-02",
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{bound}");
    // decisions #26: a 휴직 brought in while migrating is a setup record, not a 409.
    let (status, leave) = ctx
        .call("POST", &format!("/api/v1/employees/{employee}/lifecycle-events"), Some(json!({
            "event_type": "LEAVE_OF_ABSENCE", "effective_date": "2026-03-02", "leave_type": "ILLNESS",
            "expected_return_date": "2026-12-31", "comment": "이관: 휴직 중",
        })))
        .await;
    assert!(status.is_success(), "{status} {leave}");

    let (status, preview) = ctx
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["blockers"], json!([]), "{preview}");
    let second_person = "org_change_needs_second_person_after_go_live";
    assert!(!preview.to_string().contains(second_person), "{preview}");
    // regression (W10, decisions #26): under none no sole-holder tick is asked for.
    assert!(!preview.to_string().contains("sole_holder"), "{preview}");
    let digest = preview["digest"].as_str().unwrap().to_owned();

    let (status, _) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(json!({ "digest": digest })),
        )
        .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
    let step_up = passkey.step_up(&pool).await;
    let (status, done) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(json!({ "digest": digest, "step_up": step_up })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["phase"], "OPERATING");
    let notice: String =
        sqlx::query_scalar("SELECT body FROM notifications WHERE category = 'tenant.go_live'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!notice.contains("결재"), "{notice}");

    // Setup-only acts now name their governed alternative.
    let (status, refused) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({ "kind": "DEPARTMENT", "name": "기획팀", "workplace_id": workplace_id })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "phase_not_setup");
    assert_eq!(refused["error"]["reasons"], json!(["submit_org_change"]));
    // decisions #26 (approval.policy.org_structure = none): the proposal applies at submit.
    let (status, draft) = ctx
        .call("POST", "/api/v1/org-changes", Some(json!({
            "kind": "REORG", "target": {"kind": "ORG_UNIT", "ref": dept, "label": "영업팀"},
            // The server's "today" is KST: a UTC date is yesterday before 09:00 KST.
            "effectiveDate": OffsetDateTime::now_utc().to_offset(time::UtcOffset::from_hms(9, 0, 0).unwrap()).date().to_string(), "reason": "팀 이름 변경",
            "proposal": [{"op": "RENAME_ORG_UNIT", "orgUnitId": dept, "name": "영업1팀"}],
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{draft}");
    let submit = format!(
        "/api/v1/org-changes/{}/submit",
        draft["id"].as_str().unwrap()
    );
    let (status, applied) = ctx.call("POST", &submit, None).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(
        (&applied["status"], &applied["approvalSteps"]),
        (&json!("APPLIED"), &json!([]))
    );
    let (status, _) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, rail) = ctx.call("GET", "/api/v1/onboarding/checklist", None).await;
    assert_eq!(rail["phase"], "OPERATING");
    let locked: bool = sqlx::query_scalar(
        "SELECT identity_locked_at IS NOT NULL FROM legal_entities WHERE org_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(locked, "identities lock at 운영 시작");
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
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec!["SUPER_ADMIN".to_owned()],
            branches: Vec::new(),
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        vec![],
    )
    .await
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

/// MR-12 over HTTP: the tree carries versions, a stale pin is 409 with the
/// current version, a nested batch applies and its 되돌리기 takes it back,
/// an empty 부서 dissolves (DELETE) and comes back by undo.
async fn org_setup_routes(ctx: &Ctx, dept: &str, tree: &Value) {
    assert_eq!(
        tree["entities"][0]["children"][0]["children"][0]["version"], 1,
        "{tree}"
    );
    let unit = format!("/api/v1/org-structure/units/{dept}");
    let (status, stale) = ctx
        .call(
            "PATCH",
            &unit,
            Some(json!({ "name": "영업부", "expected_version": 9 })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["error"]["code"], "stale_revision");
    assert_eq!(stale["error"]["current_version"], 1);
    let (status, batch) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/batches",
            Some(json!({ "ops": [
                { "op": "CREATE", "ref": "a", "name": "영업1팀", "parent_org_unit_id": dept },
                { "op": "CREATE", "name": "A파트", "parent_ref": "a" },
            ] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{batch}");
    assert_eq!(batch["units"].as_array().unwrap().len(), 2, "{batch}");
    let undo = format!(
        "/api/v1/org-structure/batches/{}/undo",
        batch["batch_id"].as_str().unwrap()
    );
    let (status, undone) = ctx.call("POST", &undo, None).await;
    assert_eq!(status, StatusCode::CREATED, "{undone}");
    let (status, list) = ctx.call("GET", "/api/v1/org-structure/batches", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"][0]["kind"], "UNDO", "{list}");
    let (status, extra) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({ "name": "임시팀", "parent_org_unit_id": dept })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{extra}");
    let gone = format!(
        "/api/v1/org-structure/units/{}?expected_version=1",
        extra["id"].as_str().unwrap()
    );
    let (status, dissolved) = ctx.call("DELETE", &gone, None).await;
    assert_eq!(status, StatusCode::OK, "{dissolved}");
    let undo = format!(
        "/api/v1/org-structure/batches/{}/undo",
        dissolved["batch_id"].as_str().unwrap()
    );
    let (status, back) = ctx.call("POST", &undo, None).await;
    assert_eq!(status, StatusCode::CREATED, "{back}");
}
