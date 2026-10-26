// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The release router serves the same queue as Home, with no workspace opt-in.

#[path = "support/http.rs"]
mod http;
mod inbox_pool;
#[path = "period_unlock_support/mod.rs"]
mod period_support;
#[path = "inbox_journey/place_followups.rs"]
mod place_followups;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::time::{Duration as StdDuration, Instant};
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn release_inbox_serves_solo_setup_and_filters_on_the_server(pool: PgPool) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("error")
        .with_test_writer()
        .try_init();
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (status, page) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "setup_entity"),
        "{page}"
    );
    for filter in ["waiting", "scheduled", "failures"] {
        let (status, page) = ctx
            .call(
                "GET",
                &format!("/api/v1/me/action-inbox?filter={filter}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert!(
            page["items"].as_array().unwrap().is_empty(),
            "{filter}: {page}"
        );
    }
    let (status, _) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=unknown", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_grants_exposes_no_source_names_or_counts(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &[]).await;
    let ctx = http::ctx(&pool, org, user, &[], None).await;
    let (status, page) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page["items"].as_array().unwrap().is_empty(), "{page}");
    assert_eq!(page["total"], 0);
}

const INBOX: &str = "/api/v1/me/action-inbox";

async fn inbox(ctx: &http::Ctx) -> Value {
    let (status, page) = ctx.call("GET", &format!("{INBOX}?limit=200"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    page
}

fn items_of<'a>(page: &'a Value, kind: &str) -> Vec<&'a Value> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == kind)
        .collect()
}

async fn followup_person(pool: &PgPool, org: Uuid, suffix: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,employment_status,hire_date) \
         VALUES ($1,'합성 회사',$2,'inbox.csv','people',1,$2,'ACTIVE','2026-01-02') RETURNING id"
    ).bind(org).bind(format!("업무함-{suffix}")).fetch_one(pool).await.unwrap()
}

async fn assert_denied_source(pool: &PgPool, org: Uuid, kind: &str) {
    let user = http::add_user(pool, org, &[]).await;
    let viewer = http::ctx(pool, org, user, &[], None).await;
    let page = inbox(&viewer).await;
    assert!(
        items_of(&page, kind).is_empty(),
        "a refused {kind} must disclose no record: {page}"
    );
    assert_eq!(
        page["total"], 0,
        "a refused source must disclose no count: {page}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn identity_followups_match_home_and_denied_readers_see_none(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = followup_person(&pool, org, "identity").await;
    sqlx::query("UPDATE employees SET identity_review_required=true WHERE id=$1")
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let page = inbox(&ctx).await;
    let rows = items_of(&page, "identity_review");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("hr_identity:{employee}"));
    assert_eq!(rows[0]["links"][0]["id"], employee.to_string());
    assert_denied_source(&pool, org, "identity_review").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unplaced_followups_match_home_and_denied_readers_see_none(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = followup_person(&pool, org, "unplaced").await;
    let page = inbox(&ctx).await;
    let rows = items_of(&page, "unplaced");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("hr_unplaced:{employee}"));
    assert_denied_source(&pool, org, "unplaced").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renewals_use_the_tenant_window_and_denied_managers_see_none(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    // Prove the read exists before writing the new setting on the fail-before base.
    inbox(&ctx).await;
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'hr.contract_soon_days','7',$2,'BW01')")
        .bind(org).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let today = console_hr_domain::text::parse_yyyy_mm_dd(&http::today_kst()).unwrap();
    let mut inside = Uuid::nil();
    for (suffix, days) in [("near", 7), ("outside", 8)] {
        let employee = followup_person(&pool, org, suffix).await;
        if days == 7 {
            inside = employee;
        }
        sqlx::query("INSERT INTO employee_employment_profiles (org_id,employee_id,employment_type,contract_start_date,contract_end_date,phone_e164,base_pay,idempotency_key,request_hash,created_by) VALUES ($1,$2,'CONTRACT',$3,$4,'+821012345678',0,$5,repeat('a',64),$6)")
            .bind(org).bind(employee).bind(today - Duration::days(30))
            .bind(today + Duration::days(days)).bind(format!("inbox-contract-{employee}")).bind(user.as_uuid())
            .execute(&pool).await.unwrap();
    }
    let page = inbox(&ctx).await;
    let rows = items_of(&page, "contract_renewal");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("hr_contract:{inside}"));
    let due = rows[0]["due"].as_str().unwrap();
    assert!(
        due.starts_with(&(today + Duration::days(7)).to_string()),
        "{due}"
    );
    assert_eq!(rows[0]["dueTone"], "warn");
    sqlx::query("INSERT INTO platform_setting_overrides(key,value) VALUES('display.deadline_due_soon_days','2')")
        .execute(&pool).await.unwrap();
    let narrowed = inbox(&ctx).await;
    assert_eq!(
        items_of(&narrowed, "contract_renewal")[0]["dueTone"],
        "neutral"
    );
    assert_eq!(
        items_of(&narrowed, "contract_renewal")[0]["days_remaining"],
        7
    );
    assert_denied_source(&pool, org, "contract_renewal").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_completed_setup_step_leaves_the_same_inbox_without_a_second_queue(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    assert_eq!(items_of(&inbox(&ctx).await, "setup_org").len(), 1);
    let (_, workplace, _, _) = http::structure(&ctx).await;
    let (status, department) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({"name":"업무함 검증 부서","workplace_id":workplace})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{department}");
    let page = inbox(&ctx).await;
    assert!(items_of(&page, "setup_org").is_empty(), "{page}");
    assert_eq!(
        items_of(&page, "setup_entity").len(),
        1,
        "unverified registration remains outstanding"
    );
    assert_eq!(
        page["setup"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == "org")
            .unwrap()["state"],
        "done"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_product_created_people_keep_first_page_under_budget_and_cursor_stable(
    pool: PgPool,
) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (ctx, probe) = inbox_pool::context(&pool, org, user).await;
    inbox(&ctx).await;
    let (_, _, branch, unit) = http::structure(&ctx).await;
    let mut expected = BTreeSet::new();
    for index in 0..2_000 {
        let body = http::employee_body(&format!("INBOX-{index:04}"), &branch, &unit);
        let (status, created) = ctx.call("POST", "/api/v1/employees", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "person {index}: {created}");
        expected.insert(format!(
            "hr_register:{}",
            created["employee"]["id"].as_str().unwrap()
        ));
    }
    let employee = expected
        .first()
        .unwrap()
        .strip_prefix("hr_register:")
        .unwrap();
    let exit: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,'REPORTED',(clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,'업무함 기한 검증',$3) RETURNING id"
    ).bind(org).bind(uuid::Uuid::parse_str(employee).unwrap()).bind(user.as_uuid()).fetch_one(&pool).await.unwrap();
    let mut elapsed = Vec::new();
    let mut peak = 0;
    probe.reset();
    for _ in 0..20 {
        let started = Instant::now();
        let ((status, page), observed) = probe
            .measure(ctx.call("GET", &format!("{INBOX}?limit=50&filter=turn"), None))
            .await;
        peak = peak.max(observed);
        elapsed.push(started.elapsed());
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["items"].as_array().unwrap().len(), 50);
        assert_eq!(
            page["items"][0]["id"],
            format!("hr_exit:{exit}"),
            "D-day must rank on page 1 beyond 2,000 undated items"
        );
        assert_eq!(page["items"][0]["days_remaining"], 0);
    }
    elapsed.sort();
    let p95 = elapsed[18];
    eprintln!(
        "inbox: 2,000 product-created people, 20 reads, p95={p95:?}, peak pooled leases={peak}, configured source cap={}, acquisitions={}",
        probe.cap(),
        probe.acquisitions()
    );
    assert!(
        peak < probe.pool.options().get_max_connections() as usize,
        "inbox exhausted its shared runtime pool: peak {peak}, source cap {}",
        probe.cap()
    );
    assert!(
        p95 <= StdDuration::from_millis(300),
        "first-page p95 {p95:?} exceeds 300 ms"
    );

    for _ in 0..3 {
        probe.reset();
        let reads = futures::future::join_all(
            (0..6).map(|_| ctx.call("GET", "/api/v1/me/action-inbox?limit=50&filter=turn", None)),
        );
        let unrelated = async {
            // Each request acquires auth, clock and tenant connections before its sources.
            tokio::time::timeout(StdDuration::from_secs(1), async {
                while probe.acquisitions() <= 6 * 3
                    || probe.pool.size() as usize - probe.pool.num_idle() < probe.cap()
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("parallel reads never entered source fan-out");
            let started = Instant::now();
            let (status, body) = tokio::time::timeout(
                StdDuration::from_secs(1),
                ctx.call("GET", "/api/v1/users/me", None),
            )
            .await
            .expect("inbox fan-out starved an unrelated read");
            assert_eq!(status, StatusCode::OK, "{body}");
            started.elapsed()
        };
        let ((results, unrelated_elapsed), parallel_peak) = probe
            .measure(async { tokio::join!(reads, unrelated) })
            .await;
        for (status, body) in results {
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body["unavailable"].as_array().unwrap().is_empty(), "{body}");
        }
        eprintln!(
            "six parallel inbox reads: peak pooled leases={parallel_peak}, unrelated identity request={unrelated_elapsed:?}"
        );
    }
    let mut page = inbox(&ctx).await;
    let (status, late) = ctx
        .call(
            "POST",
            "/api/v1/employees",
            Some(http::employee_body("INBOX-LATE", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{late}");
    let late = late["employee"]["id"].as_str().unwrap();
    let mut seen = BTreeSet::new();
    for count in 0..200 {
        for item in page["items"].as_array().unwrap() {
            let id = item["id"].as_str().unwrap();
            assert!(
                !id.ends_with(late),
                "post-snapshot insert entered the traversal: {id}"
            );
            assert!(seen.insert(id.to_owned()), "duplicate keyset item {id}");
        }
        let Some(cursor) = page["next_cursor"].as_str() else {
            break;
        };
        assert!(
            count < 199,
            "cursor failed to finish within the known synthetic row budget"
        );
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("limit", "200")
            .append_pair("cursor", cursor)
            .finish();
        let (status, next) = ctx.call("GET", &format!("{INBOX}?{query}"), None).await;
        assert_eq!(status, StatusCode::OK, "{next}");
        page = next;
    }
    let actual = seen
        .into_iter()
        .filter(|id| id.starts_with("hr_register:"))
        .collect::<BTreeSet<_>>();
    assert_eq!(actual, expected, "every pre-snapshot record traverses once");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_security_is_personal_operating_work_until_a_second_passkey_is_registered(
    pool: PgPool,
) {
    use console_kernel_core::OrgId;
    use console_platform_test_support::soft_passkey::SoftKey;
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    assert!(items_of(&inbox(&ctx).await, "account_security").is_empty());
    SoftKey::enroll(&pool, OrgId::from_uuid(org), user).await;
    assert!(
        items_of(&inbox(&ctx).await, "account_security").is_empty(),
        "setup uses its existing passkey step"
    );
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let page = inbox(&ctx).await;
    let work = items_of(&page, "account_security");
    assert_eq!(work.len(), 1, "{page}");
    assert_eq!(work[0]["links"][0]["kind"], "account");
    assert_eq!(work[0]["links"][0]["id"], user.to_string());
    assert!(!work[0]["title"].as_str().unwrap().is_empty());
    let other = http::add_user(&pool, org, &[]).await;
    let outsider = http::ctx(&pool, org, other, &[], None).await;
    assert!(items_of(&inbox(&outsider).await, "account_security").is_empty());
    SoftKey::enroll(&pool, OrgId::from_uuid(org), user).await;
    assert!(items_of(&inbox(&ctx).await, "account_security").is_empty());
    // The owning phase read treats legacy tenants with no row as operating.
    SoftKey::enroll(&pool, OrgId::from_uuid(org), other).await;
    sqlx::query("DELETE FROM tenant_phase WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let page = inbox(&outsider).await;
    let work = items_of(&page, "account_security");
    assert_eq!(
        work.len(),
        1,
        "legacy operating accounts still need recovery work: {page}"
    );
    assert_eq!(work[0]["links"][0]["id"], other.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pending_period_unlock_is_only_the_eligible_second_persons_work_and_leaves_on_decision(
    pool: PgPool,
) {
    use console_kernel_core::{OrgId, UserId};
    use console_platform_test_support::soft_passkey::passkey_service;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    let (service, issuer) = period_support::router(&pool).await;
    let svc = passkey_service();
    let mut requester = period_support::admin(&pool, &svc, &issuer, "업무함 요청자").await;
    let mut approver = period_support::admin(&pool, &svc, &issuer, "업무함 승인자").await;
    let approver_ctx = http::Ctx {
        service: service.clone(),
        token: approver.token.clone(),
        org: *OrgId::one().as_uuid(),
        user: UserId::from_uuid(approver.id),
        key: std::cell::Cell::new(Uuid::nil()),
    };
    inbox(&approver_ctx).await;
    let (status, lock) = period_support::send(&service, period_support::LOCKS, &requester.token, None,
        json!({"domain":"payroll","periodStart":"2026-06-01","periodEnd":"2026-06-30","reasonCode":"MONTHLY_PAYROLL_CLOSE"})).await;
    assert_eq!(status, StatusCode::CREATED, "{lock}");
    let lock: Uuid = lock["id"].as_str().unwrap().parse().unwrap();
    let reason_code = "T_0123456789ABCDEF0123456789ABCDEF";
    sqlx::query("INSERT INTO reason_codes (org_id,domain,code,label_ko,requires_note,created_by) VALUES ($1,'period_unlock',$2,'추가 정산',false,$3)")
        .bind(OrgId::one().as_uuid()).bind(reason_code).bind(requester.id).execute(&pool).await.unwrap();
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&Rfc3339)
        .unwrap();
    let payload = format!("PERIOD_UNLOCK\n{lock}\n{reason_code}\n{relock_at}");
    let step_up = period_support::step_up(&pool, &svc, &mut requester, lock, &payload).await;
    let unlock = format!("{}/{lock}/unlock", period_support::LOCKS);
    let (status, pending) = period_support::send(
        &service,
        &unlock,
        &requester.token,
        None,
        json!({"reasonCode":reason_code,"relockAt":relock_at,"stepUp":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
    let request: Uuid = pending["request"]["id"].as_str().unwrap().parse().unwrap();
    let page = inbox(&approver_ctx).await;
    let rows = items_of(&page, "period_unlock");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("period_unlock:{request}"));
    assert_eq!(rows[0]["ref"], "");
    assert_eq!(rows[0]["title"], "업무함 요청자");
    assert_eq!(
        rows[0]["context"]["unlock"],
        json!({
            "domain": "payroll", "periodStart": "2026-06-01", "periodEnd": "2026-06-30",
            "requester": "업무함 요청자", "reason_code": reason_code,
            "reason_entry": {"system": false, "label_ko": "추가 정산", "label_en": null}
        })
    );
    let requester_ctx = http::Ctx {
        service: service.clone(),
        token: requester.token.clone(),
        org: *OrgId::one().as_uuid(),
        user: UserId::from_uuid(requester.id),
        key: std::cell::Cell::new(Uuid::nil()),
    };
    assert!(items_of(&inbox(&requester_ctx).await, "period_unlock").is_empty());
    let none = http::add_user(&pool, *OrgId::one().as_uuid(), &[]).await;
    let denied = http::ctx(&pool, *OrgId::one().as_uuid(), none, &[], None).await;
    assert!(items_of(&inbox(&denied).await, "period_unlock").is_empty());
    let proof = period_support::step_up(
        &pool,
        &svc,
        &mut approver,
        request,
        &format!("PERIOD_UNLOCK_APPROVE\n{request}"),
    )
    .await;
    let (status, result) = period_support::send(
        &service,
        &format!("{unlock}/approve"),
        &approver.token,
        None,
        json!({"stepUp":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(items_of(&inbox(&approver_ctx).await, "period_unlock").is_empty());
}
