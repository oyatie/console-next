// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attention_approvals_reuse_cedar_refusals_and_page_past_other_work(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let branch = seed_branch(&pool, org, "리전", "지사").await;
    let actor = UserId::new();
    let other = UserId::new();
    seed_user(&pool, org, actor, "MEMBER", branch).await;
    seed_user(&pool, org, other, "MEMBER", branch).await;
    let now = OffsetDateTime::now_utc();
    let old = now - Duration::days(12);
    let denied = seed_assigned_workflow_task(&pool, org, actor, old, Some("unknown_policy")).await;
    let mine = seed_assigned_workflow_task(&pool, org, actor, old, None).await;
    let second = seed_assigned_workflow_task(&pool, org, actor, old, None).await;
    let theirs = seed_assigned_workflow_task(&pool, org, other, old, None).await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, org, actor, "MEMBER", branch).await;
    assert_eq!(
        get(service.clone(), &format!("{PATH}?attention=all"), "")
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let first = get(
        service.clone(),
        &format!("{PATH}?attention=approvals&limit=1"),
        &token,
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.json);
    assert_eq!(first.json["items"].as_array().unwrap().len(), 1);
    assert_eq!(first.json["items"][0]["age_days"], 12);
    assert!(
        first.json["items"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("결재")
    );
    let cursor = first.json["next_cursor"].as_str().unwrap();
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("attention", "approvals")
        .append_pair("limit", "1")
        .append_pair("cursor", cursor)
        .finish();
    let next = get(service.clone(), &format!("{PATH}?{query}"), &token).await;
    assert_eq!(next.status, StatusCode::OK);
    let ids: BTreeSet<_> = [&first.json, &next.json]
        .into_iter()
        .flat_map(|p| p["items"].as_array().unwrap())
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        ids,
        BTreeSet::from([format!("approval:{mine}"), format!("approval:{second}")])
    );
    assert!(!ids.contains(&format!("approval:{denied}")));
    assert!(!ids.contains(&format!("approval:{theirs}")));
    assert!(next.json["next_cursor"].is_null());
    let all = get(
        service.clone(),
        &format!("{PATH}?attention=all&limit=200"),
        &token,
    )
    .await;
    let approvals = get(
        service,
        &format!("{PATH}?attention=approvals&limit=200"),
        &token,
    )
    .await;
    assert_eq!(
        approvals.json["attention_filters"],
        all.json["attention_filters"]
    );
    assert_eq!(approvals.json["total"], 2);
}
