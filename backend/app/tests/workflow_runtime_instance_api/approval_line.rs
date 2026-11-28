// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn effective_approval_line_survives_decisions_without_changing_the_published_template(
    pool: PgPool,
) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let author = UserId::new();
    let approver = UserId::new();
    for user in [author, approver] {
        seed_user(&pool, user, "SUPER_ADMIN", branch).await;
    }
    let token = bearer(&pool, &keys, author, "SUPER_ADMIN", branch).await;
    let approve = bearer(&pool, &keys, approver, "SUPER_ADMIN", branch).await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let definition = seed_custom_approval_definition(&pool, "approval.override.custom", |def| {
        def["nodes"][1]["required"] = json!(false);
        def["nodes"][2]["required"] = json!(false);
    })
    .await;
    let catalog = get(
        service.clone(),
        "/api/v1/workflow-studio/submittable-definitions",
        &token,
    )
    .await;
    assert_eq!(catalog.status, StatusCode::OK, "{}", catalog.json);
    assert_eq!(
        catalog.json["reviewer_role_keys"],
        json!(["hr_reviewer", "manager_approver", "executive", "admin"])
    );
    let original: Value = sqlx::query_scalar(
        "SELECT definition FROM workflow_definition_versions WHERE definition_id=$1",
    )
    .bind(definition)
    .fetch_one(&pool)
    .await
    .unwrap();
    let body = json!({
        "definition_id":definition,"idempotency_key":"workflow-custom-start-001","trigger_type":"MANUAL",
        "approval_line_overrides":[
            {"node_key":"review.hr","assignee_role_key":"manager_approver","title":"Intake"},
            {"node_key":"approve.manager","assignee_role_key":"admin","title":"Finance"},
            {"assignee_role_key":"executive","title":"Governance"},
            {"assignee_role_key":"hr_reviewer","title":"Legal"}
        ]
    });
    let started = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &token,
        body.clone(),
    )
    .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.json);
    let replay = post(service.clone(), "/api/v1/workflow-runs", &token, body).await;
    assert_eq!(replay.json["run"]["id"], started.json["run"]["id"]);
    let mut next = started.json["next_task"].clone();
    for (key, role, title, policy) in [
        ("review.hr", "manager_approver", "Intake", "approval_review"),
        ("approve.manager", "admin", "Finance", "approval_decide"),
        (
            "optional.approval.step_1",
            "executive",
            "Governance",
            "approval_decide",
        ),
        (
            "optional.approval.step_2",
            "hr_reviewer",
            "Legal",
            "approval_decide",
        ),
    ] {
        assert_eq!(next["waiting_key"], key);
        assert_eq!(next["assignee_role_key"], role);
        assert_eq!(next["title"], title);
        assert_eq!(next["required_policy"], policy);
        let task_id = next["task_id"].as_str().unwrap();
        let decided = post(
            service.clone(),
            &format!("/api/v1/workflow-tasks/{task_id}/decide"),
            &approve,
            json!({"decision":"approve","idempotency_key":format!("workflow-custom-decide-{key}")}),
        )
        .await;
        assert_eq!(decided.status, StatusCode::OK, "{}", decided.json);
        next = decided.json["next_task"].clone();
    }
    assert_eq!(next["waiting_key"], "finalize.author");
    assert_eq!(next["required_policy"], "approval_finalize");

    let published: Value = sqlx::query_scalar(
        "SELECT definition FROM workflow_definition_versions WHERE definition_id=$1",
    )
    .bind(definition)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(original, published);
    let unchanged=post(service.clone(),"/api/v1/workflow-runs",&token,json!({
        "definition_id":definition,"idempotency_key":"workflow-standard-start-001","trigger_type":"MANUAL",
        "context_payload":{"approval_line_overrides":[{"node_key":"approve.manager","assignee_role_key":"untrusted-context"}]}
    })).await;
    assert_eq!(unchanged.status, StatusCode::OK, "{}", unchanged.json);
    assert_eq!(
        unchanged.json["next_task"]["assignee_role_key"],
        "hr_reviewer"
    );
    let old_run = uuid::Uuid::parse_str(unchanged.json["run"]["id"].as_str().unwrap()).unwrap();
    let snapshot: Option<Value> =
        sqlx::query_scalar("SELECT effective_definition FROM workflow_runs WHERE id=$1")
            .bind(old_run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(snapshot.is_none());
    let first = unchanged.json["next_task"]["task_id"].as_str().unwrap();
    let decided = post(
        service.clone(),
        &format!("/api/v1/workflow-tasks/{first}/decide"),
        &approve,
        json!({
            "decision":"approve","idempotency_key":"legacy-spine-decide-001"
        }),
    )
    .await;
    assert_eq!(
        decided.json["next_task"]["assignee_role_key"],
        "manager_approver"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_line_refuses_unsupported_targets_before_creating_a_run(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let author = UserId::new();
    seed_user(&pool, author, "SUPER_ADMIN", branch).await;
    let token = bearer(&pool, &keys, author, "SUPER_ADMIN", branch).await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let definition = seed_custom_approval_definition(&pool, "approval.override.refusals", |def| {
        def["nodes"][1]["required"] = json!(false);
    })
    .await;
    for (n,steps) in [
        json!([{"node_key":"not.here","assignee_role_key":"hr_reviewer"}]),
        json!([{"node_key":"submit","assignee_role_key":"hr_reviewer"}]),
        json!([{"node_key":"finalize.author","assignee_role_key":"hr_reviewer"}]),
        json!([{"node_key":"approve.manager","assignee_role_key":"hr_reviewer"}]),
        json!([{"node_key":"review.hr","assignee_role_key":"admin"},{"node_key":"review.hr","assignee_role_key":"executive"}]),
        json!([{"assignee_role_key":"initiator"}]),
        json!([{"assignee_role_key":"unrecognized"}]),
        json!([{"assignee_role_key":"admin","title":"x".repeat(161)}]),
        json!([{"assignee_role_key":"  "}])
    ].into_iter().enumerate() {
        let bad=post(service.clone(),"/api/v1/workflow-runs",&token,json!({"definition_id":definition,
            "trigger_type":"MANUAL","idempotency_key":format!("workflow-invalid-line-{n}"),"approval_line_overrides":steps})).await;
        assert_eq!(bad.status,StatusCode::UNPROCESSABLE_ENTITY,"{}",bad.json);
    }
    assert_eq!(count_runs(&pool).await, 0);
}

pub(super) async fn seed_custom_approval_definition(
    pool: &PgPool,
    workflow_key: &str,
    customize: impl FnOnce(&mut Value),
) -> Uuid {
    let org = OrgId::one();
    let mut definition = json!({
        "schema_version": "wf.exec.v1",
        "workflow_key": workflow_key,
        "nodes": [
            { "node_key": "submit", "node_type": "object_gate", "title": "Submit" },
            { "node_key": "review.hr", "node_type": "human_task", "title": "HR review",
              "assignee_role_key": "hr_reviewer", "required_policy": "approval_review" },
            { "node_key": "approve.manager", "node_type": "human_task", "title": "Manager approval",
              "assignee_role_key": "manager_approver", "required_policy": "approval_decide" },
            { "node_key": "finalize.author", "node_type": "human_task", "title": "Author finalize",
              "assignee_role_key": "initiator", "required_policy": "approval_finalize" }
        ],
        "edges": [
            { "from": "submit", "to": "review.hr" },
            { "from": "review.hr", "to": "approve.manager" },
            { "from": "approve.manager", "to": "finalize.author" }
        ]
    });
    customize(&mut definition);
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, latest_version, active_version) \
         VALUES ($1, $2, 'Instance Approval', 'approval_document', 'ACTIVE', 1, 1) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(workflow_key)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, required_approval_line, required_payment_line) \
         VALUES ($1, $2, 1, 'PUBLISHED', $3, TRUE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(definition)
    .execute(pool)
    .await
    .unwrap();
    definition_id
}
