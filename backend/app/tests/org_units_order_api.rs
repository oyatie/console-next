#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The 부서 pickers' list (GET /org-units) shows the chart's order
//! (org-sibling-order): 사업장 and 부서 in their stored order. So does every
//! other 사업장 list a reorder through PUT /org-structure/order reaches: the
//! statutory picker, the go-live breakdown and the 근태 scope tree.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, ctx, structure, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_org_unit_list_follows_the_stored_workplace_order(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (entity, wp_hq, _, hq_site) = structure(&ctx).await;
    let reg: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(&entity).unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    // "가공장" sorts before "본사" by name; the stored order puts it last, then first.
    let (status, plant) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/workplaces"),
            Some(json!({
                "name": "가공장", "registration_id": reg, "same_address_as_registration": true,
                "opened_on": "2021-01-04", "is_head_office": false, "kind_code": "BRANCH",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{plant}");
    let plant_site = plant["record"]["org_unit_id"].as_str().unwrap().to_owned();
    // The list's children of one parent (a SITE hangs off the Company root, the tenant id).
    let children_of = |parent: String| {
        let ctx = &ctx;
        async move {
            let (status, units) = ctx.call("GET", "/api/v1/org-units", None).await;
            assert_eq!(status, StatusCode::OK, "{units}");
            units["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|u| u["parentId"] == parent.as_str())
                .map(|u| u["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    let reorder = |body: Value| {
        let ctx = &ctx;
        async move {
            let (status, saved) = ctx
                .call("PUT", "/api/v1/org-structure/order", Some(body))
                .await;
            assert_eq!(status, StatusCode::OK, "{saved}");
        }
    };
    // 사업장: creation order until one is given, then the given order.
    let wp_plant = plant["record"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        children_of(org.to_string()).await,
        vec![hq_site.clone(), plant_site.clone()]
    );
    reorder(json!({ "legal_entity_id": entity, "children": [wp_plant, wp_hq], "expected_children": [wp_hq, wp_plant] })).await;
    assert_eq!(
        children_of(org.to_string()).await,
        vec![plant_site, hq_site.clone()]
    );
    // 부서: by name until an order is given, then the given order.
    let mut depts = Vec::new();
    for name in ["나부", "가부"] {
        let (status, unit) = ctx
            .call(
                "POST",
                "/api/v1/org-structure/units",
                Some(json!({ "kind": "DEPARTMENT", "name": name, "workplace_id": wp_hq })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{unit}");
        depts.push(unit["id"].as_str().unwrap().to_owned());
    }
    let (na, ga) = (depts[0].clone(), depts[1].clone());
    assert_eq!(
        children_of(hq_site.clone()).await,
        vec![ga.clone(), na.clone()]
    );
    reorder(json!({ "workplace_id": wp_hq, "children": [na, ga], "expected_children": [ga, na] }))
        .await;
    assert_eq!(children_of(hq_site).await, vec![na, ga]);
}

async fn ids_at(ctx: &Ctx, path: &str, list: &str, kind: &str) -> Vec<String> {
    let (status, body) = ctx.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    let items = if list.is_empty() { &body } else { &body[list] };
    items
        .as_array()
        .unwrap_or_else(|| panic!("{path}: {body}"))
        .iter()
        .filter(|x| kind.is_empty() || x["kind"] == kind)
        .map(|x| x["id"].as_str().unwrap().to_owned())
        .collect()
}

/// Every 사업장 list, in its order: statutory picker, go-live breakdown, 근태 tree.
async fn workplace_lists(ctx: &Ctx) -> [Vec<String>; 3] {
    [
        ids_at(ctx, "/api/v1/statutory/workplaces", "", "").await,
        ids_at(
            ctx,
            "/api/v1/onboarding/go-live/preview",
            "breakdown",
            "workplace",
        )
        .await,
        ids_at(
            ctx,
            "/api/v1/attendance/schedule/tree",
            "nodes",
            "WORKPLACE",
        )
        .await,
    ]
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reorder_reaches_statutory_go_live_and_attendance(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(*user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (entity, hq, _, _) = structure(&ctx).await;
    let reg: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(&entity).unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    // "가공장" sorts before "본사" by name; the stored order (creation until reordered) puts 본사 first.
    let (status, plant) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/workplaces"),
            Some(json!({
                "name": "가공장", "registration_id": reg, "same_address_as_registration": true,
                "opened_on": "2021-01-04", "is_head_office": false, "kind_code": "BRANCH",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{plant}");
    let plant = plant["record"]["id"].as_str().unwrap().to_owned();
    let stored = vec![hq.clone(), plant.clone()];
    assert_eq!(
        workplace_lists(&ctx).await,
        [stored.clone(), stored.clone(), stored.clone()]
    );
    let order = |children: [&String; 2]| json!({ "legal_entity_id": entity, "children": children, "expected_children": [hq, plant] });
    let (status, saved) = ctx
        .call(
            "PUT",
            "/api/v1/org-structure/order",
            Some(order([&plant, &hq])),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let flipped = vec![plant.clone(), hq.clone()];
    assert_eq!(
        workplace_lists(&ctx).await,
        [flipped.clone(), flipped.clone(), flipped.clone()]
    );
    // A stale order is refused and changes nothing.
    let (status, refused) = ctx
        .call(
            "PUT",
            "/api/v1/org-structure/order",
            Some(order([&hq, &plant])),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        workplace_lists(&ctx).await,
        [flipped.clone(), flipped.clone(), flipped]
    );
}
