// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
pub(super) use org_change_fixtures::grant_org_approve;
#[path = "../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn assert_unbound_refusal(
    pool: &PgPool,
    rt: &PgPool,
    keys: &Keys,
    id: &str,
    step: &str,
    token: &str,
) {
    sqlx::query(
        "REVOKE EXECUTE ON FUNCTION public.console_decision_people(UUID,UUID,UUID) FROM console_rt",
    )
    .execute(pool)
    .await
    .unwrap();
    let (status, unknown) = send(
        rt,
        keys,
        "POST",
        &format!("{CHANGES}/{id}/approval-steps/{}/decision", step),
        token,
        Some(json!({"decision":"APPROVED"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{unknown}");
    assert_eq!(
        unknown["error"]["code"],
        "org_change.refuse.identity_unbound"
    );
    sqlx::query(
        "GRANT EXECUTE ON FUNCTION public.console_decision_people(UUID,UUID,UUID) TO console_rt",
    )
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn seed_user(pool: &PgPool, org: OrgId, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "WITH u AS (INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, $3, true, $4) RETURNING id, org_id) \
         INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) SELECT org_id, 'approval.policy.org_structure', '\"route\"', id, 'BW01' FROM u",
    )
    .bind(*user.as_uuid())
    .bind(format!("story-{user}"))
    .bind(vec![role])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    if role == "EXECUTIVE" {
        org_change_fixtures::grant_org_approve(pool, user).await;
    }
    user
}

pub(super) async fn approve_chain(
    pool: &PgPool,
    rt: &PgPool,
    keys: &Keys,
    org: OrgId,
    id: &str,
    steps: &Value,
) -> Value {
    let mut last = Value::Null;
    for step in steps.as_array().unwrap() {
        let actor = seed_user(pool, org, "EXECUTIVE").await;
        let token = keys.token(pool, actor, org, &["EXECUTIVE"]).await;
        let (status, detail) = send(
            rt,
            keys,
            "POST",
            &format!(
                "{CHANGES}/{id}/approval-steps/{}/decision",
                step["id"].as_str().unwrap()
            ),
            &token,
            Some(json!({"decision":"APPROVED"})),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        last = detail;
    }
    last
}
