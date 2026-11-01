// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn nullable_pay_group_choices_fail_closed_without_breaking_the_org_list(pool: PgPool) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "MEMBER").await;
    pay_view::grant_manage(&pool, org, actor, None).await;
    let entity: Uuid = sqlx::query_scalar(
        // rls-arming: ok owner seeds prerequisites; requests use console_rt.
        "INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode)
         VALUES ($1,$2,true,'MIGRATION') RETURNING id",
    )
    .bind(org.as_uuid())
    .bind(Uuid::new_v4())
    .fetch_one(&pool)
    .await
    .unwrap();
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let input = json!({"legal_entity_id":entity,"name":"모의 일반 급여 그룹",
        "pay_date_rule":{"day":"LAST_DAY","month_offset":0,"non_business_day":"PREVIOUS"},
        "base_period":{"start_day":"FIRST","month_offset":0},
        "variable_period":{"start_day":16,"month_offset":-1},
        "proration":"CALENDAR_DAYS","channel":"ATTESTATION_ONLY",
        "sensitive":false,"pay_basis_allowed":["MONTHLY"]});
    let regular = store
        .create_pay_group(org, actor, serde_json::from_value(input.clone()).unwrap())
        .await
        .unwrap();
    let pending = store
        .create_pay_group(org, actor, serde_json::from_value(input).unwrap())
        .await
        .unwrap();
    // rls-arming: ok owner models an existing row with choices not yet recorded.
    sqlx::query(
        "UPDATE pay_groups SET sensitive=NULL,pay_basis_allowed=NULL WHERE org_id=$1 AND id=$2",
    )
    .bind(org.as_uuid())
    .bind(pending.id)
    .execute(&pool)
    .await
    .unwrap();
    let keys = keys();
    let token = bearer(&pool, &keys, actor, org, "MEMBER").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let path = console_payroll_rest::PAYROLL_PAY_GROUPS_PATH;
    let pay_only = get(service.clone(), path, &token).await;
    assert_eq!(pay_only.status, StatusCode::OK, "{}", pay_only.json);
    assert_eq!(pay_only.json["items"], json!([regular]));
    pay_view::grant_sensitive(&pool, org, actor, Some(entity), "view").await;
    let cleared = get(service.clone(), path, &token).await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.json);
    let items = cleared.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let row = items
        .iter()
        .find(|g| g["id"] == pending.id.to_string())
        .unwrap();
    assert_eq!(row.get("sensitive"), Some(&Value::Null));
    assert_eq!(row.get("pay_basis_allowed"), Some(&Value::Null));
    // Clearing sensitivity must not invent an allowed pay basis either.
    // rls-arming: ok owner changes stored sensitivity between runtime-role requests.
    sqlx::query("UPDATE pay_groups SET sensitive=false WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(pending.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(get(service, path, &token).await.status, StatusCode::OK);
}
