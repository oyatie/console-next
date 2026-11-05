// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
#[path = "inbox_pool/mod.rs"]
mod inbox_pool;
use inbox_pool::{count, read};
use sqlx::PgPool;

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
    for query in [
        "limit=50",
        "filter=turn&limit=50",
        "filter=turn&attention=all&limit=50",
    ] {
        let first = read(&ctx, query).await;
        let cursor = first["next_cursor"].as_str().unwrap();
        let continuation = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("cursor", cursor)
            .finish();
        probe.reset();
        let next = read(&ctx, &format!("{query}&{continuation}")).await;
        assert!(!next["items"].as_array().unwrap().is_empty());
        assert!(
            probe.acquisitions() <= budget,
            "cursor page must share the existing source read: {query}, leases={}, budget={budget}",
            probe.acquisitions()
        );
    }
}
