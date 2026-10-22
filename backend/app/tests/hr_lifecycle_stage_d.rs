#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Stage D, as `console_rt`: lifecycle event types + state/signoff rules,
//! Idempotency-Key on lifecycle events / exit cases / users, exit-case reads,
//! `/api/v1/me/authz` org-change features, and `Accept-Language: ko` errors.

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

struct Ctx {
    service: axum::Router,
    token: String,
    keys: (String, String),
}

impl Ctx {
    async fn send(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        key: Option<&str>,
        lang: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if let Some(key) = key {
            builder = builder.header("Idempotency-Key", key);
        }
        if let Some(lang) = lang {
            builder = builder.header(header::ACCEPT_LANGUAGE, lang);
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
    }

    /// Report an exit case for `employee` dated 2026-06-30 (fresh
    /// Idempotency-Key); its id.
    async fn report_exit(&self, employee: Uuid) -> String {
        self.report_exit_on(employee, "2026-06-30").await
    }

    /// Report an exit case for `employee` effective `date`; its id.
    async fn report_exit_on(&self, employee: Uuid, date: &str) -> String {
        let key = format!("stage-d-exit-{}", Uuid::new_v4());
        let (status, body) = self
            .send(
                "POST",
                "/api/v1/hr/exit-cases",
                &self.token,
                Some(&key),
                None,
                Some(json!({
                    "employee_id": employee,
                    "effective_exit_date": date,
                    "site_manager_note": "무단결근 보고", "exit_reason_code": "PERSONAL",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["status"], "REPORTED");
        // Actor names ride next to the ids: set ones resolved, unset ones null.
        assert_eq!(body["reported_by_name"], "Stage D", "{body}");
        assert!(body["hr_confirmed_by_name"].is_null(), "{body}");
        assert!(
            body.as_object().unwrap().contains_key("closed_by_name"),
            "{body}"
        );
        body["id"].as_str().unwrap().to_owned()
    }

    /// Dashboard settlement counts: (needs source, ready, approval drafts).
    async fn settlement_counts(&self) -> (Value, Value, Value) {
        let (status, body) = self
            .send(
                "GET",
                "/api/v1/hr/absence-exit-dashboard",
                &self.token,
                None,
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let s = &body["summary"];
        (
            s["settlement_needs_source"].clone(),
            s["settlement_ready"].clone(),
            s["approval_drafts"].clone(),
        )
    }

    /// POST `/hr/exit-cases/{id}/{action}` as `token`.
    async fn exit_action(
        &self,
        case_id: &str,
        action: &str,
        token: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        self.send(
            "POST",
            &format!("/api/v1/hr/exit-cases/{case_id}/{action}"),
            token,
            None,
            None,
            Some(body),
        )
        .await
    }

    /// POST a lifecycle event with a fresh Idempotency-Key.
    async fn event(&self, employee: Uuid, body: Value) -> (StatusCode, Value) {
        let key = format!("stage-d-{}", Uuid::new_v4());
        self.send(
            "POST",
            &format!("/api/v1/employees/{employee}/lifecycle-events"),
            &self.token,
            Some(&key),
            None,
            Some(body),
        )
        .await
    }
}

fn base() -> Value {
    json!({"privacy_notice_ack": true, "korean_labor_law_ack": true})
}

fn all_acks() -> Value {
    json!({
        "privacy_notice_ack": true, "korean_labor_law_ack": true,
        "payroll_cutoff_ack": true, "retirement_settlement_ack": true
    })
}

/// The HR-tier exit confirmation body: TERMINATE takes all four acks.
fn hr_confirm() -> Value {
    json!({"signoffs": all_acks()})
}

fn ev(event_type: &str, signoffs: Value) -> Value {
    json!({
        "event_type": event_type,
        "effective_date": OffsetDateTime::now_utc().date().to_string(),
        "comment": "stage d", "leave_type": (event_type == "LEAVE_OF_ABSENCE").then_some("PERSONAL"),
        "signoffs": signoffs,
    })
}

fn with(mut body: Value, key: &str, value: Value) -> Value {
    body[key] = value;
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_events_enforce_state_and_signoff_rules(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "재직 직원").await;
    let status_of = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT employment_status FROM employees WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    // Idempotency-Key is required.
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            None,
            None,
            Some(ev("PROMOTE", base())),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["error"]["message"],
        "Idempotency-Key header is required"
    );

    // PROMOTE requires to_position.
    let (status, body) = ctx.event(emp, ev("PROMOTE", base())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "validation");
    let (status, body) = ctx
        .event(
            emp,
            with(ev("PROMOTE", base()), "to_position", json!("과장")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["to_status"], "ACTIVE");
    assert_eq!(body["to_position"], "과장");

    // No lifecycle act needs an acknowledgement (A13): a body without one records.
    let mut unsigned = with(ev("PROMOTE", json!({})), "to_position", json!("부장"));
    unsigned.as_object_mut().unwrap().remove("signoffs");
    let (status, body) = ctx.event(emp, unsigned).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["to_position"], "부장");

    // RETURN only from ON_LEAVE.
    let (status, body) = ctx.event(emp, ev("RETURN_FROM_LEAVE", base())).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "invalid_transition");

    // ACTIVE -> ON_LEAVE, with no acknowledgement (A13).
    let leave_acks = json!({});
    let (status, body) = ctx
        .event(
            emp,
            with(
                ev("LEAVE_OF_ABSENCE", leave_acks.clone()),
                "expected_return_date",
                json!("2099-01-31"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["to_status"], "ON_LEAVE");
    assert_eq!(body["from_status"], "ACTIVE");
    assert_eq!(body["expected_return_date"], "2099-01-31");
    assert_eq!(status_of(emp).await, "ON_LEAVE");

    // While ON_LEAVE: no second leave, no transfer/promote.
    for body in [
        ev("LEAVE_OF_ABSENCE", leave_acks.clone()),
        with(ev("TRANSFER", base()), "to_org_unit", json!("다른 팀")),
        with(ev("PROMOTE", base()), "to_position", json!("차장")),
    ] {
        let (status, refused) = ctx.event(emp, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    }

    // ON_LEAVE -> ACTIVE.
    let (status, body) = ctx.event(emp, ev("RETURN_FROM_LEAVE", base())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["to_status"], "ACTIVE");
    assert_eq!(status_of(emp).await, "ACTIVE");

    // Dates before effective_date are refused.
    let (status, body) = ctx
        .event(
            emp,
            with(
                ev("LEAVE_OF_ABSENCE", leave_acks.clone()),
                "expected_return_date",
                json!("2000-01-01"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // Exits are never direct lifecycle events: only an exit case exits. `event_type` is an
    // OpenAPI enum without them: refused on the wire (the domain's own refusal: normalize.rs).
    for kind in ["OFFBOARD", "TERMINATE"] {
        let (status, body) = ctx.event(emp, ev(kind, all_acks())).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("validation")),
            "{body}"
        );
    }
    assert_eq!(status_of(emp).await, "ACTIVE");

    // CONTRACT_RENEWAL: contract_end_date required; CONTRACT employment only.
    let (status, body) = ctx.event(emp, ev("CONTRACT_RENEWAL", base())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let renewal = with(
        ev("CONTRACT_RENEWAL", base()),
        "contract_end_date",
        json!("2099-12-31"),
    );
    let (status, body) = ctx.event(emp, renewal.clone()).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "imported employee has no CONTRACT profile: {body}"
    );
    let contractor = seed_employee(&pool, org, "계약 직원").await;
    seed_profile(&pool, org, contractor, admin, "CONTRACT").await;
    let (status, body) = ctx.event(contractor, renewal).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["to_status"], "ACTIVE");
    assert_eq!(body["contract_end_date"], "2099-12-31");
    let audited: String = sqlx::query_scalar(
        "SELECT after_snap->>'to_status' FROM audit_events \
         WHERE action = 'employee.lifecycle.record' AND target_id = $1",
    )
    .bind(contractor.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        audited, "ACTIVE",
        "audit records the resolved renewal status"
    );
    // A renewal may not end before the contract starts (422, not the DB CHECK's 500).
    sqlx::query(
        "UPDATE employee_employment_profiles SET contract_start_date = '2099-01-01', \
         contract_end_date = '2099-12-31' WHERE employee_id = $1",
    )
    .bind(contractor)
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = ctx
        .event(
            contractor,
            with(
                ev("CONTRACT_RENEWAL", base()),
                "contract_end_date",
                json!("2098-12-31"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["error"]["message"],
        "contract_end_date must be on or after contract_start_date"
    );
    // EXITED is never a lifecycle target: 422, not the state rule's 409.
    let (status, body) = ctx
        .event(
            emp,
            with(
                with(ev("PROMOTE", base()), "to_position", json!("부장")),
                "to_status",
                json!("EXITED"),
            ),
        )
        .await;
    // `to_status` is an OpenAPI enum without EXITED: refused on the wire (domain: normalize.rs).
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("validation")),
        "{body}"
    );

    // Exit through an exit case (HR confirmation records TERMINATE); then
    // nothing on EXITED.
    let case_id = ctx.report_exit(emp).await;
    let (status, body) = ctx
        .exit_action(&case_id, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(status_of(emp).await, "EXITED");
    let (status, body) = ctx
        .event(
            emp,
            with(ev("PROMOTE", base()), "to_position", json!("상무")),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // Korean message on q-ranked Accept-Language; code unchanged.
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            Some("stage-d-korean-message-key"),
            Some("en;q=0.5, ko;q=0.9"),
            Some(ev("RETURN_FROM_LEAVE", base())),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "invalid_transition");
    assert_eq!(
        body["error"]["message"],
        "이미 퇴사한 직원에게는 인사 이벤트를 기록할 수 없습니다."
    );

    // The ledger reads back the new fields.
    let (status, page) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_rfc3339(&page["items"][0]["created_at"]);
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_rfc3339(&detail["employee"]["created_at"]);
    assert_rfc3339(&detail["employee"]["updated_at"]);
    let types: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event_type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "TERMINATE",
            "RETURN_FROM_LEAVE",
            "LEAVE_OF_ABSENCE",
            "PROMOTE",
            "PROMOTE"
        ]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_noop_future_leave_type_allowed_events_and_filters(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "규칙 직원").await;

    // The recorder's display name travels with every event.
    let promote = with(ev("PROMOTE", base()), "to_position", json!("과장"));
    let (status, body) = ctx.event(emp, promote.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["created_by_name"], "Stage D");

    // A change that alters nothing is 422 lifecycle_noop.
    let (status, body) = ctx.event(emp, promote).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "lifecycle_noop");
    let (status, body) = ctx.event(emp, ev("TRANSFER", base())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "lifecycle_noop");

    // A future effective date schedules the event; nothing changes yet, and
    // it can be withdrawn before its date.
    let (status, body) = ctx
        .event(
            emp,
            with(
                with(ev("PROMOTE", base()), "to_position", json!("차장")),
                "effective_date",
                json!("2999-01-01"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "SCHEDULED");
    let scheduled = body["id"].as_str().unwrap().to_owned();
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{emp}/lifecycle-events/{scheduled}/cancel"),
            &ctx.token,
            None,
            None,
            Some(json!({"reason": "발령 철회"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "CANCELLED");
    assert_eq!(body["cancel_reason"], "발령 철회");

    // leave_type: LEAVE_OF_ABSENCE only, from a closed set.
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let (status, body) = ctx
        .event(
            emp,
            with(
                with(ev("PROMOTE", base()), "to_position", json!("차장")),
                "leave_type",
                json!("PERSONAL"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, body) = ctx
        .event(
            emp,
            with(
                ev("LEAVE_OF_ABSENCE", leave_acks.clone()),
                "leave_type",
                json!("SABBATICAL"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, body) = ctx
        .event(
            emp,
            with(
                ev("LEAVE_OF_ABSENCE", leave_acks),
                "leave_type",
                json!("personal"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["leave_type"], "PERSONAL");

    // allowed_events follows the same state rules the endpoint enforces.
    let allowed = |detail: &Value| -> Vec<String> {
        detail["allowed_events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event_type"].as_str().unwrap().to_owned())
            .collect()
    };
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(allowed(&detail), ["APPOINT", "RETURN_FROM_LEAVE"]);
    let other = seed_employee(&pool, org, "재직 직원").await;
    let (_, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{other}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(
        allowed(&detail).join(","),
        "ONBOARD,TRANSFER,GROUP_TRANSFER,PROMOTE,APPOINT,LEAVE_OF_ABSENCE"
    );
    // No lifecycle act requires an acknowledgement (A13).
    let transfer = &detail["allowed_events"][1];
    assert_eq!(transfer["required_signoffs"], json!([]));
    // A change of company is a 전적, refused as a TRANSFER (E-S3b).
    assert_eq!(transfer["cross_company_required_signoffs"], json!([]));
    assert_eq!(detail["allowed_events"][4]["required_signoffs"], json!([]));

    // CONTRACT_RENEWAL moves the profile's current contract end.
    let contractor = seed_employee(&pool, org, "계약 직원").await;
    seed_profile(&pool, org, contractor, admin, "CONTRACT").await;
    let (status, body) = ctx
        .event(
            contractor,
            with(
                ev("CONTRACT_RENEWAL", base()),
                "contract_end_date",
                json!("2099-12-31"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{contractor}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(
        detail["employment"]["contract_end_date"], "2099-12-31",
        "{detail}"
    );
    assert_eq!(detail["employee"]["contract_end_date"], "2099-12-31");

    // Roster filters: status list, identity review, contract end, bad status.
    let list = |query: &str| {
        let uri = format!("/api/v1/employees?{query}");
        let ctx = &ctx;
        async move { ctx.send("GET", &uri, &ctx.token, None, None, None).await }
    };
    let (status, page) = list("status=ON_LEAVE").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], emp.to_string());
    let (_, page) = list("status=ACTIVE,ON_LEAVE").await;
    assert_eq!(page["total"], 3);
    // Roster-import rows default to needing identity review.
    let (_, page) = list("identity_review_required=true").await;
    assert_eq!(page["total"], 3);
    let (_, page) = list("identity_review_required=false").await;
    assert_eq!(page["total"], 0);
    let (_, page) = list("contract_ending_before=2100-01-01").await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["contract_end_date"], "2099-12-31");
    let (status, _) = list("status=RETIRED").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_events_apply_on_their_date_or_record_the_refusal(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "예약 발령").await;
    seed_profile(&pool, org, emp, admin, "REGULAR").await;
    let runner = role_pool(&pool, "console_rt").await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let head = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT employment_status, position FROM employees WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let at = |body: Value, date: String| with(body, "effective_date", json!(date));
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});

    // Leave from day 10, return on day 20: the return is validated against
    // the employee as they will stand then (ON_LEAVE), not as they are now.
    let (status, leave) = ctx
        .event(emp, at(ev("LEAVE_OF_ABSENCE", leave_acks), day(10)))
        .await;
    assert_eq!(status, StatusCode::OK, "{leave}");
    assert_eq!(leave["state"], "SCHEDULED");
    assert_eq!(leave["to_status"], "ON_LEAVE");
    let (status, ret) = ctx
        .event(emp, at(ev("RETURN_FROM_LEAVE", base()), day(20)))
        .await;
    assert_eq!(status, StatusCode::OK, "{ret}");
    // A promotion on a day the employee will be on leave is refused now, and
    // the refusal names the scheduled leave rather than the live (ACTIVE) head.
    let (status, body) = ctx
        .event(
            emp,
            at(
                with(ev("PROMOTE", base()), "to_position", json!("과장")),
                day(15),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "lifecycle_scheduled_state", "{body}");
    assert_eq!(
        body["error"]["message"],
        format!(
            "the employee will be ON_LEAVE from {} by the scheduled LEAVE_OF_ABSENCE",
            day(10)
        )
    );
    // The detail offers the return the schedule admits after the leave.
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["schedule_after"], day(20), "{detail}");
    let schedulable: Vec<&str> = detail["allowed_scheduled_events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event_type"].as_str().unwrap())
        .collect();
    assert_eq!(
        schedulable.join(","),
        "TRANSFER,GROUP_TRANSFER,PROMOTE,APPOINT,EMPLOYMENT_TYPE_CHANGE,LEAVE_OF_ABSENCE",
        "{detail}"
    );
    // ONBOARD cannot be scheduled.
    let (status, body) = ctx.event(emp, at(ev("ONBOARD", base()), day(5))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    // One per kind and date: a second PROMOTE for day 21 must name the first (BW-11).
    let (status, first) = ctx
        .event(
            emp,
            at(
                with(ev("PROMOTE", base()), "to_position", json!("과장")),
                day(21),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let second = at(
        with(ev("PROMOTE", base()), "to_position", json!("차장")),
        day(21),
    );
    let (status, refused) = ctx.event(emp, second.clone()).await;
    assert_eq!(
        (status, &refused["error"]["code"]),
        (StatusCode::CONFLICT, &json!("scheduled_conflict"))
    );
    let second = with(
        with(second, "replaces_event_id", first["id"].clone()),
        "replace_reason_code",
        json!("SCHEDULE_CHANGED"),
    );
    let (status, promote) = ctx.event(emp, second).await;
    assert_eq!(status, StatusCode::OK, "{promote}");
    // The replaced row (CANCELLED, superseded_by, cancel_reason_code): crates/hr/adapter-postgres/tests/bw11.rs.
    // Nothing moved yet; the nearest scheduled event is announced.
    assert_eq!(head(emp).await, ("ACTIVE".to_owned(), None));
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        detail["employee"]["next_event"],
        json!({"id": leave["id"].clone(), "event_type": "LEAVE_OF_ABSENCE", "effective_date": day(10)})
    );

    // Before its date nothing applies; on it, exactly the due event does.
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(9))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(10))
            .await
            .unwrap(),
        1
    );
    assert_eq!(head(emp).await.0, "ON_LEAVE");
    let (applied_at, from_status): (Option<OffsetDateTime>, Option<String>) = sqlx::query_as(
        "SELECT applied_at, from_status FROM employee_lifecycle_events WHERE id = $1::uuid AND state = 'APPLIED'",
    )
    .bind(leave["id"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(applied_at.is_some());
    assert_eq!(from_status.as_deref(), Some("ACTIVE"));
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'employee.lifecycle.apply' AND target_id = $1",
    )
    .bind(emp.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    // An early return now would strand the scheduled return: refused, naming it.
    let (status, body) = ctx.event(emp, ev("RETURN_FROM_LEAVE", base())).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["code"], "lifecycle_schedule_conflict",
        "{body}"
    );
    assert_eq!(
        body["error"]["refusals"][0]["lifecycle_event_id"], ret["id"],
        "{body}"
    );
    assert_eq!(
        body["error"]["refusals"][0]["code"], "invalid_transition",
        "{body}"
    );
    assert_eq!(head(emp).await.0, "ON_LEAVE");
    // An import rewrites the head behind the schedule's back, so the scheduled
    // return is no longer valid on its date: APPLY_FAILED with the refusal.
    sqlx::query("UPDATE employees SET employment_status = 'ACTIVE' WHERE id = $1")
        .bind(emp)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(21))
            .await
            .unwrap(),
        2
    );
    let (status, page) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let by_id = |id: &Value| {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| &e["id"] == id)
            .unwrap()
            .clone()
    };
    let failed = by_id(&ret["id"]);
    assert_eq!(failed["state"], "APPLY_FAILED");
    assert_eq!(failed["failure_code"], "invalid_transition");
    assert_eq!(
        failed["failure_reason"],
        "RETURN_FROM_LEAVE requires an ON_LEAVE employee"
    );
    assert_eq!(by_id(&promote["id"])["state"], "APPLIED");
    assert_eq!(
        head(emp).await,
        ("ACTIVE".to_owned(), Some("차장".to_owned()))
    );
    // The refusal reads in Korean like any error message.
    let (_, ko) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            None,
            Some("ko"),
            None,
        )
        .await;
    let failed_ko = ko["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == ret["id"])
        .unwrap();
    assert_eq!(
        failed_ko["failure_reason"],
        "휴직 중인 직원만 복직할 수 있습니다."
    );
    // The failure is surfaced on the employee and findable from the list.
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        detail["employee"]["failed_event"],
        json!({"id": ret["id"].clone(), "event_type": "RETURN_FROM_LEAVE", "effective_date": day(20), "failure_code": "invalid_transition"})
    );
    let (status, page) = ctx
        .send(
            "GET",
            "/api/v1/employees?lifecycle_apply_failed=true",
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1, "{page}");
    assert_eq!(page["items"][0]["id"], emp.to_string());
    // Settled events are final: a rerun applies nothing, and cancel refuses.
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(30))
            .await
            .unwrap(),
        0
    );
    let promote_id = promote["id"].as_str().unwrap();
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{emp}/lifecycle-events/{promote_id}/cancel"),
            &ctx.token,
            None,
            None,
            Some(json!({"reason": "늦은 취소"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["employee"]["next_event"].is_null(), "{detail}");

    // An exit confirmed ahead of its last working day applies the day after it.
    let case = ctx.report_exit_on(emp, &day(40)).await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["exit_event_state"], "SCHEDULED");
    assert_eq!(head(emp).await.0, "ACTIVE");
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(41))
            .await
            .unwrap(),
        1
    );
    let exit_date: Option<String> =
        sqlx::query_scalar("SELECT exit_date::TEXT FROM employees WHERE id = $1")
            .bind(emp)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (head(emp).await.0, exit_date),
        ("EXITED".to_owned(), Some(day(40)))
    );
    let (_, page) = ctx
        .send(
            "GET",
            "/api/v1/employees?lifecycle_apply_failed=true",
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(
        page["total"], 0,
        "an exited employee has nothing to redo: {page}"
    );
    let (status, body) = ctx
        .send(
            "GET",
            &format!("/api/v1/hr/exit-cases/{case}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["exit_event_state"], "APPLIED");

    // The exit-case list filters by status and reports the filtered total.
    let (status, page) = ctx
        .send(
            "GET",
            "/api/v1/hr/exit-cases?status=HR_CONFIRMED,REPORTED&limit=1",
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        (
            page["total"].clone(),
            page["limit"].clone(),
            page["offset"].clone()
        ),
        (json!(1), json!(1), json!(0))
    );
    let (status, page) = ctx
        .send(
            "GET",
            "/api/v1/hr/exit-cases?status=CANCELLED",
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 0);
    let (status, _) = ctx
        .send(
            "GET",
            "/api/v1/hr/exit-cases?status=DONE",
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_appointment_is_all_or_nothing_audited_and_idempotent(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let first = seed_employee(&pool, org, "일괄 1").await;
    let second = seed_employee(&pool, org, "일괄 2").await;
    let on_leave = seed_employee(&pool, org, "휴직 직원").await;
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let (status, body) = ctx
        .event(on_leave, ev("LEAVE_OF_ABSENCE", leave_acks))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let team = seed_org_unit(&pool, org, admin, "정비2팀").await;
    let bulk = |key: &str, body: Value| {
        let key = key.to_owned();
        let ctx = &ctx;
        async move {
            ctx.send(
                "POST",
                "/api/v1/employees/lifecycle-events/bulk",
                &ctx.token,
                Some(&key),
                None,
                Some(body),
            )
            .await
        }
    };
    let transfer = |ids: Vec<Uuid>| {
        json!({
            "event_type": "TRANSFER",
            "employee_ids": ids,
            "to_org_unit_id": team,
            "effective_date": OffsetDateTime::now_utc().date().to_string(),
            "comment": "일괄 발령",
            "signoffs": base(),
        })
    };
    let recorded = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM employee_lifecycle_events WHERE event_type = 'TRANSFER'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };

    // One refused employee (ON_LEAVE) refuses the whole batch and names it.
    let (status, body) = bulk(
        "bulk-refused-key-0001",
        transfer(vec![first, on_leave, second]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "bulk_lifecycle_refused");
    let refusals = body["error"]["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 1, "{body}");
    assert_eq!(refusals[0]["employee_id"], on_leave.to_string());
    assert_eq!(refusals[0]["code"], "invalid_transition");
    assert_eq!(
        recorded(pool.clone()).await,
        0,
        "nothing is written on refusal"
    );

    // A missing employee is a not_found refusal, not a server error.
    let (status, body) = bulk(
        "bulk-missing-key-00001",
        transfer(vec![first, Uuid::new_v4()]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["refusals"][0]["code"], "not_found", "{body}");
    // Each refusal message is localized like the top-level one; codes stay.
    let missing = Uuid::new_v4();
    let (status, korean) = ctx
        .send(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk",
            &ctx.token,
            Some("bulk-missing-key-ko-001"),
            Some("ko"),
            Some(transfer(vec![first, missing])),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{korean}");
    let refusal = &korean["error"]["refusals"][0];
    assert_eq!(refusal["code"], "not_found", "{korean}");
    assert_ne!(
        refusal["message"], body["error"]["refusals"][0]["message"],
        "{korean}"
    );
    assert!(
        refusal["message"]
            .as_str()
            .unwrap()
            .chars()
            .any(|c| ('가'..='힣').contains(&c)),
        "{korean}"
    );

    // A repeated employee and a missing key are refused up front.
    let (status, _) = bulk("bulk-repeat-key-00001", transfer(vec![first, first])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk",
            &ctx.token,
            None,
            None,
            Some(transfer(vec![first])),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // All valid: every employee moves, one batch id, per-employee audits.
    let key = "bulk-applied-key-0001";
    let (status, body) = bulk(key, transfer(vec![second, first])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let batch = body["batch_id"].as_str().unwrap().to_owned();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["employee_id"], second.to_string(), "request order");
    for item in items {
        assert_eq!(item["batch_id"], batch);
        assert_eq!(item["to_org_unit"], "정비2팀");
    }
    let bound: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_unit_id = $1")
        .bind(team)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(bound, 2);
    let audits: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action = 'employee.lifecycle.record' AND after_snap->>'batch_id' = $1), \
                count(*) FILTER (WHERE action = 'employee.lifecycle.bulk' AND target_id = $1) \
         FROM audit_events",
    )
    .bind(&batch)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, (2, 1));

    // Exact replay returns the same batch; a now-noop re-run is refused.
    let (status, replay) = bulk(key, transfer(vec![second, first])).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["batch_id"], batch);
    assert_eq!(recorded(pool.clone()).await, 2);
    let (status, body) = bulk("bulk-noop-key-000001", transfer(vec![first])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["refusals"][0]["code"], "lifecycle_noop");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn idempotency_key_replays_and_conflicts(pool: PgPool) {
    let (ctx, org, _admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "멱등 직원").await;
    let uri = format!("/api/v1/employees/{emp}/lifecycle-events");
    let promote = with(ev("PROMOTE", base()), "to_position", json!("대리"));

    let (status, body) = ctx
        .send(
            "POST",
            &uri,
            &ctx.token,
            Some("too-short"),
            None,
            Some(promote.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    let key = "stage-d-lifecycle-key-0001";
    let (first_status, first) = ctx
        .send(
            "POST",
            &uri,
            &ctx.token,
            Some(key),
            None,
            Some(promote.clone()),
        )
        .await;
    assert_eq!(first_status, StatusCode::OK, "{first}");
    let (status, replay) = ctx
        .send(
            "POST",
            &uri,
            &ctx.token,
            Some(key),
            None,
            Some(promote.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, first);
    let (status, body) = ctx
        .send(
            "POST",
            &uri,
            &ctx.token,
            Some(key),
            None,
            Some(with(promote, "to_position", json!("과장"))),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "idempotency_key_reused");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1")
            .bind(emp)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);

    // Exit case: 201, exact replay 200 with the same case, different body 409.
    let report = json!({
        "employee_id": emp,
        "effective_exit_date": "2026-06-30",
        "site_manager_note": "무단결근 보고", "exit_reason_code": "PERSONAL",
    });
    let key = "stage-d-exit-case-key-0001";
    let (status, created) = ctx
        .send(
            "POST",
            "/api/v1/hr/exit-cases",
            &ctx.token,
            Some(key),
            None,
            Some(report.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["status"], "REPORTED");
    let (status, replay) = ctx
        .send(
            "POST",
            "/api/v1/hr/exit-cases",
            &ctx.token,
            Some(key),
            None,
            Some(report.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], created["id"]);
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/hr/exit-cases",
            &ctx.token,
            Some(key),
            None,
            Some(with(report, "site_manager_note", json!("다른 내용"))),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // Exit-case reads.
    let case_id = created["id"].as_str().unwrap();
    let (status, page) = ctx
        .send(
            "GET",
            &format!("/api/v1/hr/exit-cases?employee_id={emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], case_id);
    let (status, one) = ctx
        .send(
            "GET",
            &format!("/api/v1/hr/exit-cases/{case_id}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{one}");
    assert_eq!(one["next_actions"][0]["key"], "confirm_exit");
    assert_rfc3339(&one["reported_at"]);
    let (status, _) = ctx
        .send(
            "GET",
            &format!("/api/v1/hr/exit-cases/{}", Uuid::new_v4()),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // HR confirmation records TERMINATE and exits the employee.
    let (status, confirmed) = ctx
        .send(
            "POST",
            &format!("/api/v1/hr/exit-cases/{case_id}/confirm"),
            &ctx.token,
            None,
            None,
            Some(hr_confirm()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["status"], "HR_CONFIRMED");
    let exited: String =
        sqlx::query_scalar("SELECT employment_status FROM employees WHERE id = $1")
            .bind(emp)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(exited, "EXITED");

    // Users: 201, replay 200 same user, different body 409.
    let user = json!({"display_name": "신규 정비사"});
    let key = "stage-d-user-create-key-01";
    let (status, created) = ctx
        .send(
            "POST",
            "/api/v1/users",
            &ctx.token,
            Some(key),
            None,
            Some(user.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, replay) = ctx
        .send(
            "POST",
            "/api/v1/users",
            &ctx.token,
            Some(key),
            None,
            Some(user.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, created);
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/users",
            &ctx.token,
            Some(key),
            None,
            Some(with(user, "display_name", json!("다른 사람"))),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/users",
            &ctx.token,
            None,
            Some("ko"),
            Some(json!({"display_name": "x"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["error"]["message"],
        "Idempotency-Key 헤더가 필요합니다."
    );
}

#[path = "hr_lifecycle_stage_d/exit_case_journey.rs"]
mod exit_case_journey;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn schedule_changes_that_strand_later_events_are_refused(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "연쇄 예약").await;
    seed_profile(&pool, org, emp, admin, "REGULAR").await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let at = |body: Value, date: String| with(body, "effective_date", json!(date));
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let cancel = |event: &Value| {
        let uri = format!(
            "/api/v1/employees/{emp}/lifecycle-events/{}/cancel",
            event["id"].as_str().unwrap()
        );
        let ctx = &ctx;
        async move {
            ctx.send(
                "POST",
                &uri,
                &ctx.token,
                None,
                Some("ko"),
                Some(json!({"reason": "계획 변경"})),
            )
            .await
        }
    };
    let stranded = |(status, body): (StatusCode, Value), dependent: &Value| {
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["error"]["code"], "lifecycle_schedule_conflict",
            "{body}"
        );
        let ids: Vec<&Value> = body["error"]["refusals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| &r["lifecycle_event_id"])
            .collect();
        assert_eq!(ids, [&dependent["id"]], "{body}");
    };

    // (a) Cancelling a leave its scheduled return depends on is refused.
    let (status, leave) = ctx
        .event(emp, at(ev("LEAVE_OF_ABSENCE", leave_acks.clone()), day(10)))
        .await;
    assert_eq!(status, StatusCode::OK, "{leave}");
    let (status, ret) = ctx
        .event(emp, at(ev("RETURN_FROM_LEAVE", base()), day(20)))
        .await;
    assert_eq!(status, StatusCode::OK, "{ret}");
    let refused = cancel(&leave).await;
    assert_eq!(
        refused.1["error"]["message"],
        "이 변경 뒤에는 예약된 인사 이벤트 1건을 적용할 수 없습니다. 해당 예약을 먼저 취소하거나 고쳐 주십시오.",
        "{}",
        refused.1
    );
    assert_eq!(
        refused.1["error"]["refusals"][0]["message"],
        "휴직 중인 직원만 복직할 수 있습니다."
    );
    stranded(refused, &ret);
    // Withdrawn last-first, both go.
    let (status, body) = cancel(&ret).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["cancelled_by_name"], "Stage D", "{body}");
    let (status, body) = cancel(&leave).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // (b) An immediate leave would strand a scheduled one.
    let (status, leave) = ctx
        .event(emp, at(ev("LEAVE_OF_ABSENCE", leave_acks.clone()), day(10)))
        .await;
    assert_eq!(status, StatusCode::OK, "{leave}");
    stranded(
        ctx.event(emp, ev("LEAVE_OF_ABSENCE", leave_acks.clone()))
            .await,
        &leave,
    );
    // Scheduling a leave before a scheduled promotion strands the promotion.
    let (status, promote) = ctx
        .event(
            emp,
            at(
                with(ev("PROMOTE", base()), "to_position", json!("과장")),
                day(5),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{promote}");
    let (status, body) = cancel(&leave).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    stranded(
        ctx.event(emp, at(ev("LEAVE_OF_ABSENCE", leave_acks), day(3)))
            .await,
        &promote,
    );

    // (c) An exit confirmed for today would strand every pending event: the
    // HR confirmation is refused and the case stays REPORTED.
    let case = ctx.report_exit_on(emp, &day(0)).await;
    stranded(
        ctx.exit_action(&case, "confirm", &ctx.token, hr_confirm())
            .await,
        &promote,
    );
    let (status, body) = ctx
        .send(
            "GET",
            &format!("/api/v1/hr/exit-cases/{case}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "REPORTED");
    let (status, body) = ctx
        .exit_action(&case, "cancel", &ctx.token, json!({"reason": "다시 보고"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A scheduled exit refuses anything dated after it, naming the exit.
    let case = ctx.report_exit_on(emp, &day(30)).await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["exit_event_state"], "SCHEDULED");
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            Some(&format!("stage-d-{}", Uuid::new_v4())),
            Some("ko"),
            Some(at(
                with(ev("PROMOTE", base()), "to_position", json!("차장")),
                day(35),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "lifecycle_scheduled_state");
    assert_eq!(
        body["error"]["message"],
        format!(
            "{}부터 예약된 퇴사에 따라 퇴사 상태가 되므로 이 인사 이벤트를 기록할 수 없습니다.",
            day(30)
        )
    );
    // Nothing is schedulable after a scheduled exit.
    let (_, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(detail["allowed_scheduled_events"], json!([]), "{detail}");
    assert_eq!(detail["schedule_after"], day(30), "{detail}");
    // A second exit case cannot be reported while one is scheduled.
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/hr/exit-cases",
            &ctx.token,
            Some(&format!("stage-d-exit-{}", Uuid::new_v4())),
            None,
            Some(json!({"employee_id": emp, "effective_exit_date": day(30), "site_manager_note": "중복 보고"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["message"],
        "employee already has a scheduled exit; no exit case can be reported"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_exit_settlement_waits_for_the_exit(pool: PgPool) {
    let (ctx, org, _admin) = setup(&pool).await;
    let hq = seed_user(&pool, org, "SUPER_ADMIN").await;
    let hq_token = token(&pool, &ctx.keys, org, hq, "SUPER_ADMIN").await;
    let runner = role_pool(&pool, "console_rt").await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let exit_day = (today + Duration::days(14)).to_string();
    let emp = seed_employee(&pool, org, "정산 대기").await;
    sqlx::query("UPDATE employees SET hire_date = '2020-01-01' WHERE id = $1")
        .bind(emp)
        .execute(&pool)
        .await
        .unwrap();
    let settlement = json!({
        "average_wage_period_start": "2026-04-01",
        "average_wage_period_end": "2026-06-29",
        "average_wage_calendar_days": 90,
        "average_wage_total_won": 9_000_000,
        "monthly_ordinary_wage_won": 3_000_000,
    });
    let case = ctx.report_exit_on(emp, &exit_day).await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &hq_token,
            json!({"hq_confirmation": true, "settlement_input": settlement}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = ctx
        .exit_action(&case, "approval-draft", &ctx.token, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "APPROVAL_DRAFTED");
    // Submitting while the exit is still scheduled is refused: the case stays
    // rejectable, which withdraws the exit.
    let (status, body) = ctx
        .exit_action(&case, "approval-draft", &ctx.token, json!({"submit": true}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["message"],
        "the exit has not taken effect; submit the settlement once the employee has exited"
    );
    // Once the exit applies, the settlement files.
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(15))
            .await
            .unwrap(),
        1
    );
    let (status, body) = ctx
        .exit_action(&case, "approval-draft", &ctx.token, json!({"submit": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "SUBMITTED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runner_keeps_an_employees_events_in_date_order_after_a_fault(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "순서 보존").await;
    seed_profile(&pool, org, emp, admin, "REGULAR").await;
    let runner = role_pool(&pool, "console_rt").await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let at = |body: Value, date: String| with(body, "effective_date", json!(date));
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let (status, leave) = ctx
        .event(emp, at(ev("LEAVE_OF_ABSENCE", leave_acks), day(10)))
        .await;
    assert_eq!(status, StatusCode::OK, "{leave}");
    let (status, ret) = ctx
        .event(emp, at(ev("RETURN_FROM_LEAVE", base()), day(20)))
        .await;
    assert_eq!(status, StatusCode::OK, "{ret}");
    let state = |id: &Value| {
        let pool = pool.clone();
        let id = id.as_str().unwrap().to_owned();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT state FROM employee_lifecycle_events WHERE id = $1::uuid",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // The leave hits a server fault (its stored request is unreadable): it
    // stays SCHEDULED, and the return after it waits instead of failing
    // against the not-yet-on-leave employee.
    let request: Value = sqlx::query_scalar(
        "SELECT scheduled_request FROM employee_lifecycle_events WHERE id = $1::uuid",
    )
    .bind(leave["id"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employee_lifecycle_events SET scheduled_request = '{}'::jsonb WHERE id = $1::uuid",
    )
    .bind(leave["id"].as_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(21))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        (state(&leave["id"]).await, state(&ret["id"]).await),
        ("SCHEDULED".to_owned(), "SCHEDULED".to_owned())
    );
    // Once the fault clears, both apply in date order.
    sqlx::query("UPDATE employee_lifecycle_events SET scheduled_request = $2 WHERE id = $1::uuid")
        .bind(leave["id"].as_str().unwrap())
        .bind(request)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        console_app::apply_due_lifecycle_events(&runner, today + Duration::days(21))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        (state(&leave["id"]).await, state(&ret["id"]).await),
        ("APPLIED".to_owned(), "APPLIED".to_owned())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn readers_do_not_see_leave_types_or_cancel_reasons(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let emp = seed_employee(&pool, org, "열람 제한").await;
    seed_profile(&pool, org, emp, admin, "REGULAR").await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let leave = with(
        with(
            ev("LEAVE_OF_ABSENCE", leave_acks),
            "leave_type",
            json!("ILLNESS"),
        ),
        "effective_date",
        json!((today + Duration::days(5)).to_string()),
    );
    let (status, scheduled) = ctx.event(emp, leave).await;
    assert_eq!(status, StatusCode::OK, "{scheduled}");
    let (status, body) = ctx
        .send(
            "POST",
            &format!(
                "/api/v1/employees/{emp}/lifecycle-events/{}/cancel",
                scheduled["id"].as_str().unwrap()
            ),
            &ctx.token,
            None,
            None,
            Some(json!({"reason": "진단서 재발급 대기"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let uri = format!("/api/v1/employees/{emp}/lifecycle-events");
    let (status, page) = ctx.send("GET", &uri, &ctx.token, None, None, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["leave_type"], "ILLNESS");
    assert_eq!(page["items"][0]["cancel_reason"], "진단서 재발급 대기");
    let reader = seed_user(&pool, org, "EXECUTIVE").await;
    let reader_token = token(&pool, &ctx.keys, org, reader, "EXECUTIVE").await;
    let (status, page) = ctx.send("GET", &uri, &reader_token, None, None, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let item = page["items"][0].as_object().unwrap();
    assert!(
        !item.contains_key("leave_type") && !item.contains_key("cancel_reason"),
        "{page}"
    );
    assert_eq!(item["event_type"], "LEAVE_OF_ABSENCE");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_authz_projects_org_change_features_and_reasons_localize(pool: PgPool) {
    let (ctx, org, _admin) = setup(&pool).await;
    let caps = |body: &Value| -> Vec<String> {
        body["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["feature"].as_str().unwrap().to_owned())
            .filter(|f| f.starts_with("org_change_"))
            .collect()
    };
    let (status, body) = ctx
        .send("GET", "/api/v1/me/authz", &ctx.token, None, None, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        caps(&body),
        [
            "org_change_read",
            "org_change_draft",
            "org_change_approve",
            "org_change_apply"
        ]
    );

    let admin = seed_user(&pool, org, "ADMIN").await;
    let admin_token = token(&pool, &ctx.keys, org, admin, "ADMIN").await;
    let (status, body) = ctx
        .send("GET", "/api/v1/me/authz", &admin_token, None, None, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(caps(&body), ["org_change_read", "org_change_draft"]);
    // The handler gate reads the same matrix row.
    let (status, _) = ctx
        .send("GET", "/api/v1/org-changes", &admin_token, None, None, None)
        .await;
    assert_eq!(status, StatusCode::OK);

    // A server-authored legacy reason reads back in Korean. Region creation
    // is retired (decisions #18); closing a legacy region is still drafted.
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('수도권', $1) RETURNING id")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (status, draft) = ctx
        .send(
            "DELETE",
            &format!("/api/v1/regions/{region}"),
            &ctx.token,
            Some("stage-d-region-draft-key-01"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{draft}");
    let id = draft["id"].as_str().unwrap();
    for (language, reason) in [
        (
            None,
            "Deactivate region requested through the legacy org-setup API",
        ),
        (
            Some("ko-KR"),
            "조직 설정 화면에서 지역 비활성화를 요청했습니다.",
        ),
    ] {
        let uri = format!("/api/v1/org-changes/{id}");
        let (status, read) = ctx
            .send("GET", &uri, &ctx.token, None, language, None)
            .await;
        assert_eq!(
            (status, &read["reason"]),
            (StatusCode::OK, &json!(reason)),
            "{read}"
        );
    }
}

/// Timestamps are RFC 3339 strings, never `time`'s default tuple encoding.
fn assert_rfc3339(value: &Value) {
    let text = value
        .as_str()
        .unwrap_or_else(|| panic!("timestamp is not a string: {value}"));
    OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|err| panic!("{text} is not RFC 3339: {err}"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn setup(pool: &PgPool) -> (Ctx, Uuid, UserId) {
    let org = Uuid::new_v4();
    let slug = format!("sd-{}", &org.simple().to_string()[..12]);
    go_live::live_org(pool, org, slug, "Stage D Co").await;
    let admin = seed_user(pool, org, "SUPER_ADMIN").await;
    let keys = keys();
    let service = build_router(
        app_state(
            role_pool(pool, "console_rt").await,
            role_pool(pool, "console_leave_cmd").await,
            keys.1.clone(),
        )
        .unwrap(),
    );
    let token = token(pool, &keys, org, admin, "SUPER_ADMIN").await;
    (
        Ctx {
            service,
            token,
            keys,
        },
        org,
        admin,
    )
}

async fn seed_user(pool: &PgPool, org: Uuid, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query("WITH u AS (INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Stage D', $2, $3, true) RETURNING id, org_id) INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) SELECT org_id, 'approval.policy.exit', '\"route\"', id, 'STAGE_D' FROM u")
        .bind(*user.as_uuid())
        .bind([role].as_slice())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    console_platform_test_support::seed_passkey(pool, OrgId::from_uuid(org), user).await;
    user
}

async fn seed_employee(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, raw_row, source_metadata) \
         VALUES ($1, $2, 'Stage D Co', $3, 'roster.xlsx', 'Sheet1', 2, $4, '{}', '{}')",
    )
    .bind(id)
    .bind(org)
    .bind(name)
    .bind(format!("roster:{id}"))
    .execute(pool)
    .await
    .unwrap();
    id
}

/// An ACTIVE team as fixture rows (the org-change flow is covered elsewhere).
async fn seed_org_unit(pool: &PgPool, org: Uuid, actor: UserId, name: &str) -> Uuid {
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
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                 jsonb_build_object('name', $4::text, 'kind', 'site'), '{}'::jsonb)",
    )
    .bind(org)
    .bind(id)
    .bind(*actor.as_uuid())
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn seed_profile(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    actor: UserId,
    employment_type: &str,
) {
    sqlx::query(
        "INSERT INTO employee_employment_profiles \
         (employee_id, org_id, employment_type, phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($1, $2, $3, '+821012345678', 3000000, $4, repeat('a', 64), $5)",
    )
    .bind(employee)
    .bind(org)
    .bind(employment_type)
    .bind(format!("profile-{employee}"))
    .bind(*actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
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

async fn token(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
    role: &str,
) -> String {
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
            roles: vec![role.to_owned()],
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
        .max_connections(6)
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
