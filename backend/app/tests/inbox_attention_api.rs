// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
#[path = "inbox_pool/mod.rs"]
mod inbox_pool;
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

const INBOX: &str = "/api/v1/me/action-inbox";
async fn read(ctx: &http::Ctx, query: &str) -> Value {
    let (status, page) = ctx.call("GET", &format!("{INBOX}?{query}"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    page
}
fn count<'a>(page: &'a Value, key: &str) -> &'a Value {
    page["attention_filters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["key"] == key)
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn today_and_overdue_follow_registry_deadlines_and_partial_counts_are_marked(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let role = uuid::Uuid::new_v4();
    let maker = http::add_user(&pool, org, &[]).await;
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'퇴직 담당','ACTIVE',1,$3)")
        .bind(org).bind(role).bind(user.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'퇴직 담당','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(user.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view']),($1,$2,1,'exit',ARRAY['edit','approve'])")
        .bind(org).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org).bind(user.as_uuid()).bind(role).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let days: i64 = sqlx::query_scalar("SELECT min(value_num) FROM statutory_rules WHERE code IN ('FINAL_PAY_DUE_DAYS','SEVERANCE_PAY_DUE_DAYS') AND effective_to_exclusive IS NULL")
        .fetch_one(&pool).await.unwrap();
    let today = console_hr_domain::text::parse_yyyy_mm_dd(&http::today_kst()).unwrap();
    for (n, date) in [
        (1, today - time::Duration::days(days + 1)),
        (2, today - time::Duration::days(days)),
    ] {
        let person: uuid::Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,'회사','퇴직 직원','console','people',$2,$3) RETURNING id")
            .bind(org).bind(n).bind(n.to_string()).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by,created_at) VALUES ($1,$2,'SETTLEMENT_READY',$3,'확인',$4,now()-interval '7 days')")
            .bind(org).bind(person).bind(date).bind(user.as_uuid()).execute(&pool).await.unwrap();
    }
    let overdue = read(&ctx, "attention=overdue&limit=200").await;
    assert_eq!(overdue["items"].as_array().unwrap().len(), 1, "{overdue}");
    assert_eq!(overdue["items"][0]["kind"], "hr_exit_settle");
    assert_eq!(overdue["items"][0]["days_remaining"], -1);
    assert_eq!(overdue["items"][0]["age_days"], 7);
    let due_today = read(&ctx, "attention=today&limit=200").await;
    assert_eq!(
        due_today["items"].as_array().unwrap().len(),
        1,
        "{due_today}"
    );
    assert_eq!(due_today["items"][0]["days_remaining"], 0);
    assert_eq!(due_today["attention_filters"], overdue["attention_filters"]);
    sqlx::query("UPDATE statutory_rules SET value_num=value_num+3 WHERE code IN ('FINAL_PAY_DUE_DAYS','SEVERANCE_PAY_DUE_DAYS')")
        .execute(&pool).await.unwrap();
    let moved = read(&ctx, "attention=overdue&limit=200").await;
    assert_eq!(
        moved["items"],
        json!([]),
        "no literal deadline may override the registry"
    );
    assert_eq!(count(&moved, "overdue")["total"], 0);
    sqlx::query("ALTER TABLE change_requests RENAME TO unavailable_requests")
        .execute(&pool)
        .await
        .unwrap();
    let partial = read(&ctx, "attention=all&limit=200").await;
    assert!(!partial["unavailable"].as_array().unwrap().is_empty());
    for key in ["all", "approvals", "today", "overdue"] {
        assert_eq!(count(&partial, key)["total_is_exact"], false);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attention_rejects_unknown_values_conflicting_views_and_invalid_cursors(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &[]).await;
    let ctx = http::ctx(&pool, org, user, &[], None).await;
    for (query, expected) in [
        ("attention=unknown", StatusCode::BAD_REQUEST),
        (
            "attention=approvals&filter=waiting",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "attention=today&cursor=invalid",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let (status, _) = ctx.call("GET", &format!("{INBOX}?{query}"), None).await;
        assert_eq!(status, expected, "{query}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attention_counts_and_aging_are_scoped_and_keysets_admit_no_late_rows(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    sqlx::query("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,identity_review_required,created_at) SELECT $1,'회사','직원','console','people',n,n::text,true,now()-interval '12 days' FROM generate_series(1,3) n")
        .bind(org).execute(&pool).await.unwrap();
    let full = read(&ctx, "attention=all&limit=200").await;
    let home = read(&ctx, "attention=all&filter=turn&limit=200").await;
    assert!(
        home["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["lane"] == "turn")
    );
    assert_eq!(
        count(&home, "all"),
        &json!({"key":"all", "total":home["counts"]["turn"]["total"], "total_is_exact":home["counts"]["turn"]["total_is_exact"]})
    );

    let identities: Vec<_> = full["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "identity_review")
        .collect();
    assert_eq!(identities.len(), 3);
    for item in identities {
        assert_eq!(item["age_days"], 12);
        assert!(item.get("reason").is_none());
    }
    let mut page = read(&ctx, "attention=all&limit=1").await;
    assert_eq!(count(&page, "all")["total_is_exact"], true);
    assert_eq!(page["items"][0]["context"]["review_count"], 3);
    let expected = full["total"].as_u64().unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,identity_review_required) VALUES ($1,'회사','나중 직원','console','people',4,'late',true)")
        .bind(org).execute(&pool).await.unwrap();
    let mut ids = std::collections::BTreeSet::new();
    loop {
        for item in page["items"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
            assert_ne!(item["title"], "나중 직원");
        }
        let Some(cursor) = page["next_cursor"].as_str() else {
            break;
        };
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("attention", "all")
            .append_pair("limit", "1")
            .append_pair("cursor", cursor)
            .finish();
        page = read(&ctx, &query).await;
    }
    assert_eq!(ids.len() as u64, expected);
    let denied_user = http::add_user(&pool, org, &[]).await;
    let denied = http::ctx(&pool, org, denied_user, &[], None).await;
    let (other, other_user) = http::tenant(&pool, &[]).await;
    let foreign = http::ctx(&pool, other, other_user, &[], None).await;
    for reader in [&denied, &foreign] {
        for attention in ["all", "approvals", "today", "overdue"] {
            let page = read(reader, &format!("attention={attention}")).await;
            assert_eq!(page["items"], json!([]));
            for key in ["all", "approvals", "today", "overdue"] {
                assert_eq!(count(&page, key)["total"], 0);
                assert_eq!(count(&page, key)["total_is_exact"], true);
            }
        }
    }
    let (foreign_org, admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let foreign_admin = http::ctx(&pool, foreign_org, admin, &["SUPER_ADMIN"], None).await;
    let page = read(&foreign_admin, "attention=all&limit=200").await;
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["kind"] != "identity_review")
    );
    assert_eq!(
        count(&page, "all")["total"].as_u64().unwrap(),
        page["items"].as_array().unwrap().len() as u64
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attention_counts_for_two_thousand_items_keep_the_existing_read_budget(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (ctx, probe) = inbox_pool::context(&pool, org, user).await;
    let empty = read(&ctx, "attention=all&limit=50").await;
    let seed = "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,identity_review_required,employment_status) SELECT $1,'회사','직원','console','people',n,n::text,false,'ACTIVE' FROM generate_series($2::int,$3::int) n";
    sqlx::query(seed)
        .bind(org)
        .bind(1)
        .bind(2)
        .execute(&pool)
        .await
        .unwrap();
    read(&ctx, "attention=all&limit=50").await;
    probe.reset();
    let small = read(&ctx, "attention=all&limit=50").await;
    let budget = probe.acquisitions();
    assert_eq!(
        count(&small, "all")["total"].as_u64().unwrap()
            - count(&empty, "all")["total"].as_u64().unwrap(),
        4
    );
    sqlx::query(seed)
        .bind(org)
        .bind(3)
        .bind(1000)
        .execute(&pool)
        .await
        .unwrap();
    let mut samples = Vec::new();
    let mut acquisitions = Vec::new();
    for _ in 0..20 {
        probe.reset();
        let start = std::time::Instant::now();
        let (page, peak) = probe.measure(read(&ctx, "attention=all&limit=50")).await;
        assert!(peak < probe.pool.options().get_max_connections() as usize);
        samples.push(start.elapsed());
        acquisitions.push(probe.acquisitions());
        assert_eq!(
            count(&page, "all")["total"].as_u64().unwrap(),
            count(&empty, "all")["total"].as_u64().unwrap() + 2000
        );
        assert!(
            count(&page, "all")["total"].as_u64().unwrap()
                >= count(&small, "all")["total"].as_u64().unwrap()
        );
        assert_eq!(count(&page, "all")["total_is_exact"], true);
        assert_eq!(count(&page, "approvals")["total_is_exact"], true);
    }
    samples.sort();
    eprintln!(
        "attention 2000-item p95={:?}, source cap={}, leases={acquisitions:?}",
        samples[18],
        probe.cap()
    );
    assert!(
        acquisitions.iter().all(|n| *n <= budget),
        "counts must share the existing source read"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attention_all_keeps_turn_filter_and_excludes_waiting_and_scheduled(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    for (n, status) in [(1, "IN_APPROVAL"), (2, "APPROVED")] {
        sqlx::query("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,$2,'REORG',$3,'REGION','region','Region',CURRENT_DATE+7,'Review','[]',$4,$5,repeat('a',64))")
            .bind(org).bind(format!("OC-2026-{n:04}")).bind(status).bind(user.as_uuid()).bind(uuid::Uuid::new_v4().to_string()).execute(&pool).await.unwrap();
    }
    let all = read(&ctx, "attention=all&limit=200").await;
    for lane in ["waiting", "scheduled"] {
        assert!(
            all["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["lane"] == lane),
            "{all}"
        );
    }
    let home = read(&ctx, "attention=all&filter=turn&limit=200").await;
    assert!(
        home["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["lane"] == "turn"),
        "{home}"
    );
    assert_eq!(count(&home, "all")["total"], all["counts"]["turn"]["total"]);
    assert_eq!(
        count(&home, "all")["total_is_exact"],
        all["counts"]["turn"]["total_is_exact"]
    );
    for attention in ["approvals", "today", "overdue"] {
        let view = read(
            &ctx,
            &format!("attention={attention}&filter=turn&limit=200"),
        )
        .await;
        assert_eq!(view["attention_filters"], home["attention_filters"]);
    }
}
