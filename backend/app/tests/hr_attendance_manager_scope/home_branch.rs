// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_grant_home_branch_put_hides_existence_and_version(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, "home").await;
    let owner = seed_user(&pool, "SUPER_ADMIN", None).await;
    let actor = seed_user(&pool, "MEMBER", Some(branch)).await;
    let employee = seed_employee_attendance(&pool, owner, branch).await;
    let before = routing(&pool, employee).await;
    let token = bearer(&pool, &keys, actor, "MEMBER").await;
    let app = build_router(
        app_state(runtime_role_pool(&pool).await, keys.public_pem)
            .unwrap()
            .with_leave_command_database(leave_command_role_pool(&pool).await),
    );
    let mut refusals = Vec::new();
    let mut messages = Vec::new();
    for (label, id, target, at) in [
        ("unknown employee", Uuid::new_v4(), branch, before.1),
        (
            "stale version",
            employee,
            branch,
            before.1 - Duration::seconds(1),
        ),
        ("unknown branch", employee, Uuid::new_v4(), before.1),
    ] {
        let response = app.clone().oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/employees/{id}/home-branch"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&json!({
                    "branch_id": target,
                    "expected_updated_at": at.format(&time::format_description::well_known::Rfc3339).unwrap(),
                })).unwrap())).unwrap(),
        ).await.unwrap();
        let status = response.status();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        refusals.push((label, status, body["error"]["code"].clone()));
        messages.push(body["error"]["message"].clone());
        assert_eq!(
            routing(&pool, employee).await,
            before,
            "{label} wrote routing or audit"
        );
    }
    assert_eq!(
        refusals,
        vec![
            (
                "unknown employee",
                StatusCode::FORBIDDEN,
                json!("forbidden")
            ),
            ("stale version", StatusCode::FORBIDDEN, json!("forbidden")),
            ("unknown branch", StatusCode::FORBIDDEN, json!("forbidden")),
        ]
    );
    assert!(
        messages.windows(2).all(|pair| pair[0] == pair[1]),
        "{messages:?}"
    );
}

async fn routing(owner: &PgPool, employee: Uuid) -> (Option<Uuid>, OffsetDateTime, i64) {
    sqlx::query_as("SELECT home_branch_id,updated_at,(SELECT count(*) FROM audit_events WHERE target_id=$1::text AND action='employee.home_branch_set') FROM employees WHERE id=$1")
        .bind(employee).fetch_one(owner).await.unwrap()
}
