#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real org units end to end, as `console_rt`: the Company root, org-change
//! governed Site/Department/Team creation, rename/move, dissolve blockers,
//! employee binding (create + TRANSFER), headcount, and the import-row detail.

#[path = "support/go_live.rs"]
mod go_live;
use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
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
const UNITS: &str = "/api/v1/org-units";
const CHANGES: &str = "/api/v1/org-changes";
const EMPLOYEES: &str = "/api/v1/employees";

struct Ctx {
    service: axum::Router,
    drafter: String,
    approver: String,
    org: Uuid,
    branch: Uuid,
    seq: std::cell::Cell<u32>,
}

impl Ctx {
    fn key(&self) -> String {
        let n = self.seq.get() + 1;
        self.seq.set(n);
        format!("org-units-test-key-{n:04}")
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header("Idempotency-Key", self.key());
        let request = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                builder.body(Body::from(body.to_string())).unwrap()
            }
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        )
    }

    async fn units(&self) -> Vec<Value> {
        let (status, body) = self.call("GET", UNITS, &self.drafter, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["items"].as_array().unwrap().clone()
    }

    async fn unit(&self, id: &str) -> Option<Value> {
        self.units().await.into_iter().find(|u| u["id"] == id)
    }

    /// Draft through the convenience endpoint, then submit → 4 ordered
    /// approvals by a second SUPER_ADMIN → effectuate. Returns the final detail.
    async fn govern(&self, method: &str, uri: &str, body: Option<Value>) -> Value {
        let (status, draft) = self.call(method, uri, &self.drafter, body).await;
        assert_eq!(status, StatusCode::CREATED, "draft {method} {uri}: {draft}");
        self.approve_and_effectuate(draft["id"].as_str().unwrap())
            .await
    }

    async fn approve_and_effectuate(&self, id: &str) -> Value {
        let (status, submitted) = self
            .call(
                "POST",
                &format!("{CHANGES}/{id}/submit"),
                &self.drafter,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "submit: {submitted}");
        for step in submitted["approvalSteps"].as_array().unwrap() {
            let (status, decided) = self
                .call(
                    "POST",
                    &format!(
                        "{CHANGES}/{id}/approval-steps/{}/decision",
                        step["id"].as_str().unwrap()
                    ),
                    &self.approver,
                    Some(json!({"decision": "APPROVED"})),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "decide: {decided}");
        }
        let (status, applied) = self
            .call(
                "POST",
                &format!("{CHANGES}/{id}/effectuate"),
                &self.approver,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "effectuate: {applied}");
        applied
    }

    async fn preflight_codes(&self, id: &str) -> Vec<String> {
        let (status, body) = self
            .call(
                "POST",
                &format!("{CHANGES}/{id}/preflight"),
                &self.drafter,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "preflight: {body}");
        body["preflight"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["code"].as_str().unwrap().to_owned())
            .collect()
    }

    /// Create a unit through the full governed lifecycle; returns its id.
    async fn create_unit(&self, kind: &str, parent: Option<&str>, name: &str) -> String {
        let before: Vec<String> = self
            .units()
            .await
            .iter()
            .map(|u| u["id"].as_str().unwrap().to_owned())
            .collect();
        let (status, draft) = self
            .call(
                "POST",
                UNITS,
                &self.drafter,
                Some(json!({"kind": kind, "parentId": parent, "name": name})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{draft}");
        assert_eq!(draft["proposal"][0]["op"], "CREATE_ORG_UNIT");
        // Not visible before effectuate.
        assert!(
            self.units().await.iter().all(|u| u["name"] != name),
            "{name} visible before effectuate"
        );
        let applied = self
            .approve_and_effectuate(draft["id"].as_str().unwrap())
            .await;
        assert_eq!(applied["status"], "APPLIED", "{applied}");
        let created = self
            .units()
            .await
            .into_iter()
            .find(|u| !before.contains(&u["id"].as_str().unwrap().to_owned()))
            .expect("new unit visible after effectuate");
        assert_eq!(created["name"], name);
        assert_eq!(created["kind"], kind);
        assert_eq!(created["status"], "ACTIVE");
        created["id"].as_str().unwrap().to_owned()
    }

    fn employee_body(&self, number: &str, org_unit_id: Option<&str>) -> Value {
        let mut body = json!({
            "employee_number": number,
            "name": format!("직원 {number}"),
            "company": "조직 테스트 법인",
            "employment_type": "REGULAR",
            "phone": "010-1234-5678",
            "position": "사원",
            "site": "서울",
            "home_branch_id": self.branch,
            "base_pay": "3000000",
            "idempotency_key": format!("emp-create-{number}"),
            "hire_date": "2026-01-02",
        });
        if let Some(id) = org_unit_id {
            body["org_unit_id"] = json!(id);
        }
        body
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_units_are_governed_bound_and_counted(pool: PgPool) {
    let org = Uuid::new_v4();
    seed_org(&pool, org, "Org Units Co").await;
    let drafter = seed_user(&pool, org).await;
    let approver = seed_user(&pool, org).await;
    let branch = seed_branch(&pool, org).await;
    let keys = keys();
    let service = build_router(
        app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            keys.1.clone(),
        )
        .unwrap(),
    );
    let ctx = Ctx {
        service,
        drafter: token(&pool, &keys, org, drafter).await,
        approver: token(&pool, &keys, org, approver).await,
        org,
        branch,
        seq: std::cell::Cell::new(0),
    };
    let org_s = org.to_string();

    // Empty tree: the Company root only (the tenant IS the Company).
    let root = ctx.units().await;
    assert_eq!(root.len(), 1, "{root:?}");
    assert_eq!(root[0]["kind"], "COMPANY");
    assert_eq!(root[0]["id"], org_s);
    assert_eq!(root[0]["name"], "Org Units Co");
    assert_eq!(root[0]["parentId"], Value::Null);

    // Kind nesting: a DEPARTMENT straight under the Company is a preflight blocker.
    let (status, bad) = ctx
        .call(
            "POST",
            UNITS,
            &ctx.drafter,
            Some(json!({"kind": "DEPARTMENT", "parentId": org_s, "name": "X"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{bad}");
    assert_eq!(
        ctx.preflight_codes(bad["id"].as_str().unwrap()).await,
        ["ORG_UNIT_KIND_NESTING"]
    );
    // Unknown / foreign parent is 404 at draft (deny by omission).
    let (status, _) = ctx
        .call(
            "POST",
            UNITS,
            &ctx.drafter,
            Some(json!({"kind": "DEPARTMENT", "parentId": Uuid::new_v4(), "name": "Y"})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A bare SITE is never proposed (decisions #18, proved in org_change_api):
    // a 사업장's own unit comes with the 사업장, so the site is a fixture here.
    let site = seed_fixture_unit(&pool, org, "본사").await.to_string();
    assert_eq!(ctx.unit(&site).await.unwrap()["parentId"], org_s);
    let dept = ctx.create_unit("DEPARTMENT", Some(&site), "정비부").await;
    let team1 = ctx.create_unit("DEPARTMENT", Some(&dept), "정비1팀").await;
    let team2 = ctx.create_unit("DEPARTMENT", Some(&dept), "정비2팀").await;
    assert_eq!(ctx.unit(&team1).await.unwrap()["parentId"], dept);

    // Rename.
    ctx.govern(
        "PATCH",
        &format!("{UNITS}/{team1}"),
        Some(json!({"name": "정비A팀"})),
    )
    .await;
    assert_eq!(ctx.unit(&team1).await.unwrap()["name"], "정비A팀");
    let (status, detail) = ctx
        .call("GET", &format!("{UNITS}/{team1}"), &ctx.drafter, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(detail["revisions"][0]["name"], "정비A팀");
    // The revision's actor is named server-side (null only when unknown).
    assert_eq!(detail["revisions"][0]["actorName"], "Admin", "{detail}");

    // Move team2 under a second department.
    let dept2 = ctx.create_unit("DEPARTMENT", Some(&site), "관리부").await;
    ctx.govern(
        "PATCH",
        &format!("{UNITS}/{team2}"),
        Some(json!({"parentId": dept2})),
    )
    .await;
    assert_eq!(ctx.unit(&team2).await.unwrap()["parentId"], dept2);

    // Cycle: team3 under team1, then team1 under team3.
    let team3 = ctx.create_unit("DEPARTMENT", Some(&team1), "A-1팀").await;
    let (status, cyc) = ctx
        .call(
            "PATCH",
            &format!("{UNITS}/{team1}"),
            &ctx.drafter,
            Some(json!({"parentId": team3})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{cyc}");
    assert_eq!(
        ctx.preflight_codes(cyc["id"].as_str().unwrap()).await,
        ["ORG_UNIT_CYCLE"]
    );

    // Employees: placement is optional at registration -- 미배치 is never a refusal
    // (console-react docs/design/onboarding-and-migration.md C1, AM-5) -- so an
    // unplaced person registers in no unit. Placed: bound, projected, counted.
    let body = Some(ctx.employee_body("E-000", None));
    let (status, u) = ctx.call("POST", EMPLOYEES, &ctx.drafter, body).await;
    let unplaced = (status, u["employee"]["org_unit_id"].is_null());
    assert_eq!(unplaced, (StatusCode::CREATED, true), "{u}");
    let (status, created) = ctx
        .call(
            "POST",
            EMPLOYEES,
            &ctx.drafter,
            Some(ctx.employee_body("E-001", Some(&team1))),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let employee_id = created["employee"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["employee"]["org_unit_id"], team1);
    assert_eq!(created["employee"]["org_unit"], "정비A팀");
    assert_eq!(ctx.unit(&team1).await.unwrap()["headcount"], 1);
    assert_eq!(ctx.unit(&team2).await.unwrap()["headcount"], 0);
    // The Company root counts every non-exited person, placed or not: E-000 and E-001.
    assert_eq!(ctx.unit(&org_s).await.unwrap()["headcount"], 2);

    // Foreign tenant's unit: 404, nothing written.
    let foreign_org = Uuid::new_v4();
    seed_org(&pool, foreign_org, "Foreign Co").await;
    seed_user(&pool, foreign_org).await;
    let foreign_unit = seed_fixture_unit(&pool, foreign_org, "남의 팀").await;
    let (status, foreign) = ctx
        .call(
            "POST",
            EMPLOYEES,
            &ctx.drafter,
            Some(ctx.employee_body("E-002", Some(&foreign_unit.to_string()))),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{foreign}");
    let (status, _) = ctx
        .call(
            "GET",
            &format!("{UNITS}/{foreign_unit}"),
            &ctx.drafter,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Dissolve blocked while it has members: preflight blocker, submit refused.
    let (status, dissolve) = ctx
        .call("DELETE", &format!("{UNITS}/{team1}"), &ctx.drafter, None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{dissolve}");
    let dissolve_id = dissolve["id"].as_str().unwrap();
    let codes = ctx.preflight_codes(dissolve_id).await;
    assert!(
        codes.contains(&"ORG_UNIT_ACTIVE_MEMBERS".to_owned()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"ORG_UNIT_ACTIVE_CHILDREN".to_owned()),
        "{codes:?}"
    );
    let (status, refused) = ctx
        .call(
            "POST",
            &format!("{CHANGES}/{dissolve_id}/submit"),
            &ctx.drafter,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Distinct from a generic conflict, naming every blocker code.
    assert_eq!(refused["error"]["code"], "preflight_blocked", "{refused}");
    let reasons = refused["error"]["reasons"].as_array().unwrap();
    for code in ["ORG_UNIT_ACTIVE_MEMBERS", "ORG_UNIT_ACTIVE_CHILDREN"] {
        assert!(reasons.iter().any(|r| r == code), "{refused}");
    }

    // TRANSFER rebinds; headcount follows.
    let (status, moved) = ctx
        .call(
            "POST",
            &format!("{EMPLOYEES}/{employee_id}/lifecycle-events"),
            &ctx.drafter,
            Some(json!({
                "event_type": "TRANSFER",
                "to_org_unit_id": team2,
                "effective_date": OffsetDateTime::now_utc().date().to_string(),
                "comment": "정비2팀 전보",
                "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["to_org_unit"], "정비2팀");
    let (status, detail) = ctx
        .call(
            "GET",
            &format!("{EMPLOYEES}/{employee_id}"),
            &ctx.drafter,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["employee"]["org_unit_id"], team2);
    assert_eq!(ctx.unit(&team1).await.unwrap()["headcount"], 0);
    assert_eq!(ctx.unit(&team2).await.unwrap()["headcount"], 1);

    // Org chart groups by the real unit.
    let (status, chart) = ctx
        .call("GET", "/api/v1/hr/org-chart", &ctx.drafter, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{chart}");
    let units = chart["companies"][0]["units"].as_array().unwrap();
    assert!(
        units
            .iter()
            .any(|u| u["org_unit_id"] == team2 && u["name"] == "정비2팀"),
        "{chart}"
    );

    // Dissolve an empty leaf: DISSOLVE kind applies on its 시행일 (UX-R2
    // org-05: no tick list) → DISSOLVED; then it cannot take a new employee (422).
    let (status, dissolve) = ctx
        .call("DELETE", &format!("{UNITS}/{team3}"), &ctx.drafter, None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{dissolve}");
    let id = dissolve["id"].as_str().unwrap().to_owned();
    let applied = ctx.approve_and_effectuate(&id).await;
    assert_eq!(applied["status"], "APPLIED");
    assert_eq!(applied["settlementItems"], json!([]));
    assert_eq!(ctx.unit(&team3).await.unwrap()["status"], "DISSOLVED");
    let (status, dissolved) = ctx
        .call(
            "POST",
            EMPLOYEES,
            &ctx.drafter,
            Some(ctx.employee_body("E-003", Some(&team3))),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{dissolved}");

    // Roster-import rows carry no employment profile: detail is 200 with
    // `employment: null`, not 404.
    let imported = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, raw_row, source_metadata) \
         VALUES ($1, $2, '조직 테스트 법인', '임포트 직원', 'roster.xlsx', 'Sheet1', 2, 'roster:2', '{}', '{}')",
    )
    .bind(imported)
    .bind(ctx.org)
    .execute(&pool)
    .await
    .unwrap();
    let (status, detail) = ctx
        .call(
            "GET",
            &format!("{EMPLOYEES}/{imported}"),
            &ctx.drafter,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["employment"], Value::Null);
    assert_eq!(detail["employee"]["org_unit_id"], Value::Null);
}

/// An employee registered through `POST /api/v1/employees` — no separate
/// `hr.appoint` — is moved by an org-change REASSIGN_ORG_UNIT (title and status
/// kept), and an ON_LEAVE member is a member: counted, a dissolve blocker until
/// moved, and moved by the reassign.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reassign_moves_registered_and_on_leave_members(pool: PgPool) {
    let org = Uuid::new_v4();
    seed_org(&pool, org, "Reassign Co").await;
    let drafter = seed_user(&pool, org).await;
    let approver = seed_user(&pool, org).await;
    let branch = seed_branch(&pool, org).await;
    let keys = keys();
    let service = build_router(
        app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            keys.1.clone(),
        )
        .unwrap(),
    );
    let ctx = Ctx {
        service,
        drafter: token(&pool, &keys, org, drafter).await,
        approver: token(&pool, &keys, org, approver).await,
        org,
        branch,
        seq: std::cell::Cell::new(0),
    };
    let today = OffsetDateTime::now_utc()
        .to_offset(time::UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
        .to_string();
    let site = seed_fixture_unit(&pool, org, "본사").await.to_string();
    let dept = ctx.create_unit("DEPARTMENT", Some(&site), "정비부").await;
    let from = ctx.create_unit("DEPARTMENT", Some(&dept), "정비1팀").await;
    let to = ctx.create_unit("DEPARTMENT", Some(&dept), "정비2팀").await;

    let register = |number: &'static str| {
        let body = ctx.employee_body(number, Some(&from));
        let ctx = &ctx;
        async move {
            let (status, created) = ctx.call("POST", EMPLOYEES, &ctx.drafter, Some(body)).await;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            created["employee"]["id"].as_str().unwrap().to_owned()
        }
    };

    // The only member goes on leave: still a member, still a dissolve blocker.
    let on_leave = register("E-201").await;
    let (status, leave) = ctx
        .call(
            "POST",
            &format!("{EMPLOYEES}/{on_leave}/lifecycle-events"),
            &ctx.drafter,
            Some(json!({
                "event_type": "LEAVE_OF_ABSENCE",
                "effective_date": today,
                "comment": "육아휴직", "leave_type": "CHILDCARE", "expected_return_date": "2999-01-31",
                "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true},
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{leave}");
    assert_eq!(leave["to_status"], "ON_LEAVE");
    assert_eq!(ctx.unit(&from).await.unwrap()["headcount"], 1);
    let (status, dissolve) = ctx
        .call("DELETE", &format!("{UNITS}/{from}"), &ctx.drafter, None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{dissolve}");
    let dissolve_id = dissolve["id"].as_str().unwrap().to_owned();
    assert_eq!(
        ctx.preflight_codes(&dissolve_id).await,
        ["ORG_UNIT_ACTIVE_MEMBERS"]
    );

    let active = register("E-202").await;
    // A member under another company string (e.g. an imported 법인 name) is
    // counted by the dissolve headcount, so the reassign must move it too.
    let mut body = ctx.employee_body("E-203", Some(&from));
    body["company"] = json!("다른 법인");
    let (status, created) = ctx.call("POST", EMPLOYEES, &ctx.drafter, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let other_company = created["employee"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ctx.unit(&from).await.unwrap()["headcount"], 3);
    // Registration opened each canonical employment (the binding a transfer needs).
    let bound: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employment_source_bindings WHERE org_id = $1 AND employee_id IN ($2, $3)",
    )
    .bind(org)
    .bind(Uuid::parse_str(&on_leave).unwrap())
    .bind(Uuid::parse_str(&active).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bound, 2);

    let applied = ctx
        .govern(
            "POST",
            CHANGES,
            Some(json!({
                "kind": "REORG",
                "target": {"kind": "ORG_UNIT", "ref": from, "label": "정비1팀 인원 이동"},
                "effectiveDate": today,
                "reason": "정비1팀 해산 전 인원 이동",
                "proposal": [{
                    "op": "REASSIGN_ORG_UNIT",
                    "fromOrgUnit": from,
                    "toOrgUnit": to,
                    "scope": {"company": "조직 테스트 법인"},
                }],
            })),
        )
        .await;
    assert_eq!(applied["status"], "APPLIED", "{applied}");

    for (id, status) in [(&on_leave, "ON_LEAVE"), (&active, "ACTIVE")] {
        let (code, detail) = ctx
            .call("GET", &format!("{EMPLOYEES}/{id}"), &ctx.drafter, None)
            .await;
        assert_eq!(code, StatusCode::OK, "{detail}");
        let employee = &detail["employee"];
        assert_eq!(employee["org_unit_id"], to, "{detail}");
        assert_eq!(employee["org_unit"], "정비2팀", "{detail}");
        assert_eq!(employee["position"], "사원", "{detail}");
        assert_eq!(employee["status"], status, "{detail}");
        let targets: Vec<String> = sqlx::query_scalar(
            "SELECT r.receipt->>'target' FROM employment_revisions r \
             JOIN employment_source_bindings b \
               ON b.org_id = r.org_id AND b.employment_id = r.employment_id \
             WHERE b.org_id = $1 AND b.employee_id = $2 ORDER BY r.version",
        )
        .bind(org)
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_all(&pool)
        .await
        .unwrap();
        // UX-R2 org-04: the move is a dated 전보 in the person's 인사 이력
        // (hr's lifecycle record, batched under the change), not a bare
        // canonical hr.transfer; a 휴직자 (hr refuses their TRANSFER) moves
        // with the unit and keeps no event.
        assert_eq!(targets, ["hr.appoint"]);
        let transfers: Vec<Option<Uuid>> = sqlx::query_scalar(
            "SELECT batch_id FROM employee_lifecycle_events WHERE org_id = $1 \
             AND employee_id = $2 AND event_type = 'TRANSFER'",
        )
        .bind(org)
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_all(&pool)
        .await
        .unwrap();
        let change = Uuid::parse_str(applied["id"].as_str().unwrap()).unwrap();
        let expected: Vec<Option<Uuid>> = if status == "ACTIVE" {
            vec![Some(change)]
        } else {
            vec![]
        };
        assert_eq!(transfers, expected, "{id} {status}");
    }
    let (code, detail) = ctx
        .call(
            "GET",
            &format!("{EMPLOYEES}/{other_company}"),
            &ctx.drafter,
            None,
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{detail}");
    assert_eq!(detail["employee"]["org_unit_id"], to, "{detail}");
    assert_eq!(detail["employee"]["company"], "다른 법인", "{detail}");
    assert_eq!(ctx.unit(&from).await.unwrap()["headcount"], 0);
    assert_eq!(ctx.unit(&to).await.unwrap()["headcount"], 3);
    // Emptied, the unit may be dissolved.
    assert!(ctx.preflight_codes(&dissolve_id).await.is_empty());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn seed_org(pool: &PgPool, org: Uuid, name: &str) {
    let slug = format!("ou-{}", &org.simple().to_string()[..12]);
    go_live::live_org(pool, org, slug, name).await;
}

async fn seed_user(pool: &PgPool, org: Uuid) -> UserId {
    let user = UserId::new();
    sqlx::query("WITH u AS (INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Admin', $2, $3, true) RETURNING id, org_id) INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) SELECT org_id, 'approval.policy.org_structure', '\"route\"', id, 'BW01' FROM u")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    console_platform_test_support::seed_passkey(pool, OrgId::from_uuid(org), user).await;
    user
}

async fn seed_branch(pool: &PgPool, org: Uuid) -> Uuid {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('수도권', $1) RETURNING id")
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, '본점', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// An ACTIVE site as fixture rows (a 사업장's own unit is made by the entity
/// face; decisions #18 retired bare SITE proposals).
async fn seed_fixture_unit(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         SELECT $1, $2, 1, gen_random_uuid(), u.id, decode(repeat('00', 32), 'hex'), \
                jsonb_build_object('name', $3::text, 'kind', 'site'), '{}'::jsonb \
         FROM users u WHERE u.org_id = $1 LIMIT 1",
    )
    .bind(org)
    .bind(id)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    id
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
                let statement = match role {
                    "console_rt" => "SET ROLE console_rt",
                    _ => "SET ROLE console_leave_cmd",
                };
                sqlx::query(statement).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

fn app_state(
    runtime: PgPool,
    leave_command: PgPool,
    public_pem: String,
) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
}
