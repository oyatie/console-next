// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{INBOX, day, filing, filings, http, item, list, rows, snooze, today, until};
use super::{org_change_fixtures, person_fixtures};
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use time::Date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_refusal_names_its_reason_and_writes_nothing(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    filings(&pool, org, *maker.as_uuid()).await;
    let ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let page = list(&ctx, "?limit=200").await;
    let legal = filing(&page);
    let id = legal["id"].as_str().unwrap();
    // The list read logged the personnel rows it showed; a refused command shows none and writes no audit row at all.
    assert!(
        access_logged(&pool, org).await > 0,
        "the fixture shows personnel rows: {page}"
    );
    let written = audited(&pool, org).await;

    // Today or earlier is not later.
    for date in [day(0), day(-1)] {
        let (status, body) = until(&ctx, id, &date).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "snooze_past", "{date}: {body}");
    }
    let (status, body) = until(&ctx, id, "soon").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "validation", "{body}");

    // A legal deadline: the day before it is the last day the item may return.
    let latest = legal["snooze"]["latest"].as_str().unwrap();
    let last = Date::parse(
        latest,
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .unwrap();
    assert!(last > today(), "the fixture's filing is due later: {legal}");
    let (status, body) = until(&ctx, id, &last.next_day().unwrap().to_string()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "snooze_past_legal_due", "{body}");
    assert_eq!(body["error"]["details"]["latest"], latest, "{body}");

    // Not in my inbox, unknown and malformed are one answer.
    let unknown = format!("hr_request:{}", Uuid::new_v4());
    for target in [unknown.as_str(), "not-an-id"] {
        for (status, body) in [
            until(&ctx, target, &day(1)).await,
            ctx.call("DELETE", &snooze(target), None).await,
        ] {
            assert_eq!(status, StatusCode::NOT_FOUND, "{target}: {body}");
            assert_eq!(body["error"]["code"], "lifecycle.refuse.scope", "{body}");
        }
    }

    assert_eq!(audited(&pool, org).await, written);

    // A decision someone is waiting on cannot be postponed by the one who decides.
    let checker = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, checker).await;
    org_change_fixtures::grant_org_approve(&pool, checker).await;
    let request: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE + 30,'Review','[]',$2,gen_random_uuid()::text,repeat('a',64)) RETURNING id")
        .bind(org).bind(maker.as_uuid()).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,1,'hr')")
        .bind(org).bind(request).execute(&pool).await.unwrap();
    let decision = format!("org_change:{request}");
    let decider = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let queue = list(&decider, "").await;
    let row = item(&queue, &decision).unwrap_or_else(|| panic!("{queue}"));
    assert_eq!(row["kind"], "org_change_approve", "{row}");
    assert_eq!(
        row["snooze"],
        json!({"allowed": false, "reason": "blocks_others"})
    );
    let written = audited(&pool, org).await;
    let (status, body) = until(&decider, &decision, &day(1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "snooze_not_allowed", "{body}");
    assert_eq!(audited(&pool, org).await, written);

    assert_eq!(rows(&pool, org).await, 0);
    assert_eq!(http::audits(&pool, org, "action_inbox.snooze").await, 0);

    // The requester only waits on it, and the last legal day is allowed.
    assert!(
        item(&list(&ctx, "?limit=200").await, &decision).is_some(),
        "the requester sees the decision they wait on"
    );
    let (status, body) = until(&ctx, &decision, &day(1)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    // The version the command stored is the one the list compares, so the decision stays postponed.
    assert!(item(&list(&ctx, "?limit=200").await, &decision).is_none());
    let (status, body) = until(&ctx, id, latest).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(rows(&pool, org).await, 2);
    let (status, body) = ctx
        .call("GET", &format!("{INBOX}?snoozed=only&limit=0"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Every audit row of the tenant except the command journal, which records each refused command as it should.
async fn audited(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action NOT IN ('command.received','command.refused')")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Personnel access events written by inbox reads.
async fn access_logged(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action IN ('employee.list_read','employee_exit_case.list_read')")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}
