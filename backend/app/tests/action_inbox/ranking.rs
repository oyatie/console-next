// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadline_keyset_traverses_mixed_sources_after_refresh(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::one(), "혼합 리전", "혼합 지사").await;
    let alice = UserId::new();
    seed_user(&pool, OrgId::one(), alice, "MEMBER", branch).await;
    let bob = UserId::new();
    seed_user(&pool, OrgId::one(), bob, "MEMBER", branch).await;
    let equipment = seed_equipment(&pool, OrgId::one(), branch, "mixed").await;
    let base = OffsetDateTime::now_utc() - Duration::hours(1);

    let work = seed_assigned_work_order(
        &pool,
        OrgId::one(),
        branch,
        equipment,
        alice,
        "20260704-101",
    )
    .await;
    set_work_times(&pool, work, base, base + Duration::hours(4)).await;
    let support = seed_assigned_support_ticket(&pool, OrgId::one(), branch, alice, base).await;
    let hidden_workflow = seed_assigned_workflow_task(
        &pool,
        OrgId::one(),
        alice,
        base - Duration::seconds(1),
        Some("unknown_policy"),
    )
    .await;
    let workflow = seed_assigned_workflow_task(&pool, OrgId::one(), alice, base, None).await;
    let dispatch_work =
        seed_assigned_work_order(&pool, OrgId::one(), branch, equipment, bob, "20260704-102").await;
    let dispatch =
        seed_dispatch_offer(&pool, OrgId::one(), branch, dispatch_work, bob, alice, base).await;

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, OrgId::one(), alice, "MEMBER", branch).await;
    let first = get(service.clone(), &format!("{PATH}?limit=2"), &token).await;
    assert_eq!(first.status, StatusCode::OK, "{:?}", first.json);
    assert_eq!(first.json["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(first.json["total"], 4);
    assert_eq!(first.json["total_is_exact"], true);
    assert!(first.json["next_cursor"].is_string());

    sqlx::query(
        "UPDATE work_orders SET target_due_at = target_due_at + interval '30 days' WHERE id = $1",
    )
    .bind(*work.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE support_tickets SET due_at = now() - interval '30 days' WHERE id = $1")
        .bind(*support.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE workflow_waiting_tasks SET due_at = now() + interval '45 days' WHERE id = $1",
    )
    .bind(workflow)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE p1_dispatches SET accept_window_ends_at = now() + interval '45 days' WHERE id = $1",
    )
    .bind(dispatch)
    .execute(&pool)
    .await
    .unwrap();
    // A deliberate refresh starts a new deadline traversal after deadlines change.
    let first = get(service.clone(), &format!("{PATH}?limit=2"), &token).await;
    assert_eq!(first.json["items"][0]["id"], format!("support:{support}"));
    let cursor = first.json["next_cursor"]
        .as_str()
        .expect("refreshed second page");
    let post_snapshot = seed_assigned_work_order(
        &pool,
        OrgId::one(),
        branch,
        equipment,
        alice,
        "20260704-103",
    )
    .await;
    let after_as_of = OffsetDateTime::now_utc() + Duration::days(1);
    set_work_times(&pool, post_snapshot, after_as_of, after_as_of).await;

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("limit", "2")
        .append_pair("cursor", cursor)
        .finish();
    let second = get(service, &format!("{PATH}?{query}"), &token).await;
    assert_eq!(second.status, StatusCode::OK, "{:?}", second.json);
    assert_eq!(second.json["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(second.json["total"], 4);
    assert_eq!(second.json["total_is_exact"], true);
    assert!(second.json["next_cursor"].is_null());
    let ids = first.json["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second.json["items"].as_array().unwrap())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let unique = ids.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(
        ids.len(),
        4,
        "all pre-as_of mixed rows must traverse: {ids:?}"
    );
    assert_eq!(unique.len(), 4, "immutable keyset must not duplicate rows");
    assert!(
        !ids.contains(&format!("approval:{hidden_workflow}")),
        "authorization-filtered workflow rows must not inflate totals or consume the page"
    );
    assert_eq!(
        ids,
        vec![
            format!("support:{support}"),
            format!("work:{work}"),
            format!("approval:{workflow}"),
            format!("dispatch:{dispatch}"),
        ],
        "source deadlines determine the order after an explicit refresh"
    );
    assert!(!ids.contains(&format!("work:{post_snapshot}")));
}
