// SPDX-License-Identifier: LicenseRef-Proprietary
use super::membership_api::{MEMBERS, assign, send};
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn membership_resolves_competing_moves_once_and_requires_source_and_tenant_authority(
    pool: PgPool,
) {
    let org = OrgId::one();
    let (service, token, sensitive, actor, clearance) = setup(&pool).await;
    let entity = group_entity(&pool, sensitive).await;
    let site = workplace(&pool, entity).await;
    let person = employee(&pool, Some((entity, site)), None).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let mut body = pay_groups_api::input(entity);
    body["name"] = json!("Ordinary");
    body["sensitive"] = json!(false);
    let ordinary = store
        .create_pay_group(org, actor, serde_json::from_value(body).unwrap())
        .await
        .unwrap()
        .id;
    let date = "2026-04-01";
    let (a, b) = tokio::join!(
        assign(&service, &token, person, sensitive, None, date),
        assign(&service, &token, person, ordinary, None, date)
    );
    let (ok, conflict, winner) = if a.status == StatusCode::OK {
        (a, b, sensitive)
    } else {
        (b, a, ordinary)
    };
    assert_eq!(
        (
            ok.status,
            conflict.status,
            conflict.json["error"]["code"].as_str()
        ),
        (
            StatusCode::OK,
            StatusCode::CONFLICT,
            Some("membership_changed")
        )
    );
    if winner == ordinary {
        assert_eq!(
            assign(&service, &token, person, sensitive, Some(ordinary), date)
                .await
                .status,
            StatusCode::OK
        );
    }
    let retry_person = employee(&pool, Some((entity, site)), None).await;
    let key = Uuid::new_v4().to_string();
    let body = json!({"pay_group_id":sensitive,"employee_id":retry_person,"expected_pay_group_id":null,"effective_from":date});
    let written = send(&service, &token, &body, &key).await;
    let replay = send(&service, &token, &body, &key).await;
    assert_eq!(written.status, StatusCode::OK, "{}", written.json);
    assert_eq!(
        (replay.status, &replay.json["id"]),
        (StatusCode::OK, &written.json["id"]),
        "{}",
        replay.json
    );
    // rls-arming: ok owner revokes clearance between requests made as the tenant runtime role.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    let withheld = send(&service, &token, &body, &key).await;
    assert_eq!(
        (withheld.status, withheld.json["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("command_applied"))
    );
    let candidates =
        |id: Uuid| format!("{MEMBERS}?pay_group_id={id}&effective_from={date}&q=Employee");
    let hidden = get(service.clone(), &candidates(ordinary), &token).await;
    assert_eq!((hidden.status, hidden.json), (StatusCode::OK, json!([])));
    assert_eq!(
        get(service.clone(), &candidates(sensitive), &token)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        assign(&service, &token, person, ordinary, Some(sensitive), date)
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let other = OrgId::new();
    let foreign_actor =
        seed_org_and_super_admin(&pool, *other.as_uuid(), "membership-foreign").await;
    let foreign_entity = pay_groups_api::entity(&pool, other).await;
    pay_view::grant_manage(&pool, other, foreign_actor, None).await;
    pay_view::grant_sensitive(&pool, other, foreign_actor, None, "edit").await;
    let foreign = store
        .create_pay_group(
            other,
            foreign_actor,
            serde_json::from_value(pay_groups_api::input(foreign_entity)).unwrap(),
        )
        .await
        .unwrap()
        .id;
    assert_eq!(
        get(service.clone(), &candidates(foreign), &token)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        assign(&service, &token, person, foreign, Some(sensitive), date)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn membership_guards_a_closed_sole_group_roster_without_an_explicit_assignment(pool: PgPool) {
    let (service, token, original, actor, _) = setup(&pool).await;
    let entity = group_entity(&pool, original).await;
    let site = workplace(&pool, entity).await;
    let recorded = employee(&pool, Some((entity, site)), None).await;
    let run = create(
        service.clone(),
        &token,
        original,
        "REGULAR",
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(run.status, StatusCode::CREATED, "{}", run.json);
    let id: Uuid = serde_json::from_value(run.json["id"].clone()).unwrap();
    assert_eq!(roster(&pool, id).await[0].0, Some(recorded));
    // rls-arming: ok owner advances this materialised synthetic run to the closed attendance phase.
    let date: String = sqlx::query_scalar("UPDATE payroll_draft_runs SET status='ATTENDANCE_CLOSED' WHERE id=$1 RETURNING period_start::text")
        .bind(id).fetch_one(&pool).await.unwrap();
    let mut body = pay_groups_api::input(entity);
    body["name"] = json!("New group");
    let target = PgPayrollStore::new(runtime_role_pool(&pool).await)
        .create_pay_group(OrgId::one(), actor, serde_json::from_value(body).unwrap())
        .await
        .unwrap()
        .id;
    let later = employee(&pool, Some((entity, site)), None).await;
    assert_eq!(
        assign(&service, &token, later, target, None, &date)
            .await
            .status,
        StatusCode::OK
    );
    let result = assign(&service, &token, recorded, target, None, &date).await;
    assert_eq!(
        (result.status, result.json["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("pay_group_membership_frozen"))
    );
}
