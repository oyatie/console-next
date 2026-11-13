// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{age_scale, http, registration};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn explain_filing_hydration(
    pool: &PgPool,
    org: Uuid,
    page: &Value,
    events: &[Value],
) {
    let sql = events
        .iter()
        .filter_map(|e| e["fields"]["db.statement"].as_str())
        .find(|s| s.contains("WHERE inbox_id = ANY("))
        .unwrap();
    let ids: Vec<String> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| {
            item["id"]
                .as_str()
                .filter(|id| id.starts_with("insurance_filing_"))
                .map(str::to_owned)
        })
        .collect();
    assert!(
        !ids.is_empty(),
        "current hires must exercise filing hydration"
    );
    let bounds: Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('code',code,'effective_from',effective_from,'earliest_event_on',NULL)) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL")
        .fetch_one(pool).await.unwrap();
    let as_of = time::OffsetDateTime::parse(
        page["as_of"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(pool).await;
    let statement = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
    let plan: Value = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
        &runtime,
        console_kernel_core::OrgId::from_uuid(org),
        move |tx| {
            Box::pin(async move {
                sqlx::query("SET LOCAL jit=off")
                    .execute(tx.as_mut())
                    .await?;
                Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(statement))
                    .bind(org)
                    .bind(bounds)
                    .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"])
                    .bind(as_of)
                    .bind(&ids)
                    .bind(&ids)
                    .bind(as_of)
                    .fetch_one(tx.as_mut())
                    .await?)
            })
        },
    )
    .await
    .unwrap();
    fn probes(node: &Value) -> u64 {
        let own = if node["Relation Name"] == "person_revisions" {
            node["Actual Loops"].as_u64().unwrap()
        } else {
            0
        };
        node["Plans"].as_array().map_or(own, |children| {
            own.max(children.iter().map(probes).max().unwrap_or(0))
        })
    }
    let probes = probes(&plan[0]["Plan"]);
    eprintln!(
        "filing EXPLAIN: person revision probes={probes}, execution_ms={}",
        plan[0]["Execution Time"]
    );
    assert!(
        probes > 0 && probes <= 52,
        "filing hydration scanned beyond its selected batch: {plan}"
    );
}

pub(super) async fn assert_count_cohorts(pool: &PgPool) {
    let f = registration::fixture(pool.clone()).await;
    let org = *f.principal.org_id.as_uuid();
    let mut expected = std::collections::BTreeSet::new();
    for (key, complete, birth) in [
        ("both", false, false),
        ("birth", true, false),
        ("birth-second", true, false),
        ("complete", true, true),
    ] {
        let id = f.create(f.body(key, "REGULAR")).await.unwrap().employee.id;
        if !birth {
            expected.insert(id);
        }
        if complete {
            sqlx::query(
                "UPDATE employees SET job='개발',birth_date=$3::date WHERE org_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(id)
            .bind(birth.then_some("1990-01-02"))
            .execute(pool)
            .await
            .unwrap();
            let address: Uuid = sqlx::query_scalar("INSERT INTO employee_addresses(org_id,employee_id,source,road_addr_part1,si_nm,created_by) VALUES($1,$2,'MANUAL_UNVERIFIED','서울특별시 강남구 테헤란로 152','서울특별시',$3) RETURNING id")
                .bind(org).bind(id).bind(f.principal.user_id.as_uuid()).fetch_one(pool).await.unwrap();
            sqlx::query("INSERT INTO employee_register_facts(org_id,employee_id,sex,address_id,career_none) VALUES($1,$2,'MALE',$3,true)")
                .bind(org).bind(id).bind(address).execute(pool).await.unwrap();
        }
    }
    let as_of = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(pool)
        .await
        .unwrap();
    let page =
        f.hr.register_review_inbox_page(&f.principal, as_of, None, 10)
            .await
            .unwrap();
    assert_eq!(
        page.total, 3,
        "gap cohorts must be disjoint and include birth-only gaps"
    );
    assert_eq!(
        page.items
            .iter()
            .map(|item| item.0)
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
}

pub(super) async fn seed(
    pool: &PgPool,
    org: Uuid,
    user: console_kernel_core::UserId,
    place: (&str, &str, &str, &str),
    size: i32,
) {
    age_scale::seed(
        pool,
        org,
        user,
        place.0.parse().unwrap(),
        place.1.parse().unwrap(),
        size,
        0,
    )
    .await;
    // Match product registration's canonical person bindings, not just legacy employee rows.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Match the product journey's current-day hires and acquisition workload.
    sqlx::query(
        "UPDATE employees SET hire_on=current_date,hire_date=current_date::text,birth_date=NULL,home_branch_id=$2,org_unit_id=$3 WHERE org_id=$1",
    )
    .bind(org)
    .bind(place.2.parse::<Uuid>().unwrap())
    .bind(place.3.parse::<Uuid>().unwrap())
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employee_lifecycle_events SET effective_date=current_date::text WHERE org_id=$1",
    )
    .bind(org)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("UPDATE employment_assignments SET valid_from=current_date WHERE org_id=$1")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO persons(org_id,id) SELECT org_id,id FROM employees WHERE org_id=$1 ON CONFLICT DO NOTHING")
        .bind(org).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO person_revisions(org_id,person_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT e.org_id,e.id,1,gen_random_uuid(),$2,decode(repeat('00',32),'hex'),jsonb_build_object('legal_name',e.name,'birth_date',e.birth_date),'{}' FROM employees e WHERE e.org_id=$1 AND NOT EXISTS(SELECT 1 FROM person_revisions r WHERE r.org_id=e.org_id AND r.person_id=e.id)")
        .bind(org).bind(user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_person_bindings(org_id,employee_id,person_id,actor_id,payload_digest) SELECT org_id,id,id,$2,decode(repeat('00',32),'hex') FROM employees WHERE org_id=$1 ON CONFLICT DO NOTHING")
        .bind(org).bind(user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql("ANALYZE employee_person_bindings; ANALYZE person_revisions")
        .execute(pool)
        .await
        .unwrap();
}

pub(super) async fn explain_register(pool: &PgPool, org: Uuid, page: &Value, events: &[Value]) {
    let as_of = time::OffsetDateTime::parse(
        page["as_of"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(pool).await;
    for count in [false, true] {
        let sql = events
            .iter()
            .filter_map(|e| e["fields"]["db.statement"].as_str())
            .find(|s| {
                if count {
                    s.contains("FROM employees g") && s.contains("person_employees_current")
                } else {
                    s.trim_start()
                        .starts_with("SELECT e.id, e.name, e.created_at")
                        && s.contains("hr_register:")
                }
            })
            .unwrap();
        let statement = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
        let plan: Value = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
            &runtime,
            console_kernel_core::OrgId::from_uuid(org),
            move |tx| {
                Box::pin(async move {
                    let mut query = sqlx::query_scalar(sqlx::AssertSqlSafe(statement))
                        .bind(org)
                        .bind(as_of);
                    query = if count {
                        query.bind(org).bind(as_of)
                    } else {
                        query.bind(52_i64)
                    };
                    Ok(query.fetch_one(tx.as_mut()).await?)
                })
            },
        )
        .await
        .unwrap();
        fn inspect(node: &Value, indexed: &mut bool, revisions: &mut u64) {
            assert_ne!(
                node["Relation Name"], "employment_assignments",
                "tenant-wide register work must not resolve placements"
            );
            *indexed |= node["Index Name"] == "employees_org_register_inbox_order_idx";
            if node["Relation Name"] == "person_revisions" {
                *revisions = (*revisions).max(node["Actual Loops"].as_u64().unwrap());
            }
            if let Some(children) = node["Plans"].as_array() {
                for child in children {
                    inspect(child, indexed, revisions);
                }
            }
        }
        let (mut indexed, mut revisions) = (false, 0);
        inspect(&plan[0]["Plan"], &mut indexed, &mut revisions);
        eprintln!(
            "register EXPLAIN: count={count}, index={indexed}, person revision probes={revisions}, execution_ms={}",
            plan[0]["Execution Time"]
        );
        if count {
            assert_eq!(
                revisions, 0,
                "obvious register gaps must not hydrate person revisions: {plan}"
            );
        } else {
            assert!(
                indexed,
                "register keyset must use its tenant/order index: {plan}"
            );
            assert!(
                revisions > 0 && revisions <= 52,
                "person hydration escaped the page: {plan}"
            );
        }
    }
}

pub(super) async fn assert_source_isolation(pool: &PgPool, ctx: &http::Ctx) {
    sqlx::query("ALTER TABLE employee_exit_cases RENAME TO unavailable_exit_cases")
        .execute(pool)
        .await
        .unwrap();
    let (status, page) = ctx.call("GET", super::FIRST, None).await;
    sqlx::query("ALTER TABLE unavailable_exit_cases RENAME TO employee_exit_cases")
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    let unavailable = page["unavailable"].as_array().unwrap();
    assert_eq!(
        unavailable.len(),
        1,
        "a broken exit source must remain isolated: {page}"
    );
    assert_eq!(unavailable[0]["source"], "hr_exit");
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "insurance_filing")
    );
}
