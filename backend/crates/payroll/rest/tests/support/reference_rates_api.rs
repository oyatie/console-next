// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

const RATES: &str = "/api/v1/payroll/reference/rates";

async fn setup(pool: &PgPool) -> (axum::Router, String, Uuid, UserId) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(pool, actor, *org.as_uuid(), "MEMBER").await;
    let entity = super::entity(pool, org).await;
    pay_view::grant_view(pool, org, actor, Some(entity)).await;
    let keys = keys();
    let token = bearer(pool, &keys, actor, org, "MEMBER").await;
    (
        app(runtime_role_pool(pool).await, &keys),
        token,
        entity,
        actor,
    )
}

fn uri(entity: Uuid) -> String {
    format!("{RATES}?legal_entity_id={entity}")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rates_returns_exact_current_register_and_nullable_fields(pool: PgPool) {
    let (service, token, entity, _) = setup(&pool).await;
    let response = get(service, &uri(entity), &token).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.json);
    assert_eq!(response.json.as_object().unwrap().len(), 3);
    assert_eq!(response.json["country_code"], "KR");
    assert_eq!(response.json["adopted"], true);
    // rls-arming: ok owner independently reads the public citation source for comparison.
    let expected: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r)-'country_code' FROM payroll_statutory_rates r WHERE effective_from<=entity_today() AND (effective_to_exclusive IS NULL OR effective_to_exclusive>entity_today()) ORDER BY code,effective_from")
        .fetch_all(&pool).await.unwrap();
    let items = response.json["items"].as_array().unwrap();
    assert!(!items.is_empty());
    assert_eq!(items.len(), expected.len());
    for (item, citation) in items.iter().zip(expected) {
        let mut actual = item.clone();
        let actual = actual.as_object_mut().unwrap();
        assert_eq!(actual.remove("name").unwrap(), citation["instrument_ko"]);
        let value = actual.remove("value").unwrap();
        let status = actual.remove("status").unwrap();
        let expected_value = match (
            citation["rate_num"].as_i64(),
            citation["rate_den"].as_i64(),
            citation["floor_won"].as_i64(),
            citation["cap_won"].as_i64(),
        ) {
            (Some(num), Some(den), _, _) => json!(format!("{num}/{den}")),
            (_, _, Some(floor), Some(cap)) => json!(format!("{floor}–{cap}원")),
            _ => Value::Null,
        };
        assert_eq!(value, expected_value);
        assert_eq!(status, if value.is_null() { "HELD" } else { "ACTIVE" });
        assert_eq!(json!(actual), citation);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rates_refuses_without_live_cedar_and_cross_tenant_entities(pool: PgPool) {
    let (service, token, entity, actor) = setup(&pool).await;
    let other_org = OrgId::new();
    seed_org_and_super_admin(&pool, *other_org.as_uuid(), "other company").await;
    let foreign = super::entity(&pool, other_org).await;
    let sibling = super::entity(&pool, OrgId::one()).await;
    for target in [foreign, sibling, Uuid::new_v4()] {
        let response = get(service.clone(), &uri(target), &token).await;
        assert_eq!(response.status, StatusCode::FORBIDDEN);
        assert_eq!(response.json["error"]["code"], "forbidden");
        assert!(response.json.get("items").is_none());
    }
    // rls-arming: ok owner revokes the fixture grant while retaining the bearer.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1")
        .bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let revoked = get(service, &uri(entity), &token).await;
    assert_eq!(revoked.status, StatusCode::FORBIDDEN);
    assert_eq!(revoked.json["error"]["code"], "forbidden");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rates_never_substitutes_zero_for_unknown(pool: PgPool) {
    let (service, token, entity, _) = setup(&pool).await;
    // rls-arming: ok owner models an unknown value in the global reference source.
    sqlx::query("UPDATE payroll_statutory_rates SET rate_num=NULL,rate_den=NULL,floor_won=NULL,cap_won=NULL WHERE code='NATIONAL_PENSION_EMPLOYEE'")
        .execute(&pool).await.unwrap();
    let response = get(service, &uri(entity), &token).await;
    assert_eq!(response.status, StatusCode::OK);
    let unknown = response.json["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["code"] == "NATIONAL_PENSION_EMPLOYEE")
        .unwrap();
    assert_eq!(unknown["value"], Value::Null);
    assert_eq!(unknown["rate_num"], Value::Null);
    assert_eq!(unknown["status"], "HELD");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rates_unknown_country_never_falls_back_to_korean_register(pool: PgPool) {
    let (service, token, entity, _) = setup(&pool).await;
    // rls-arming: ok owner supplies a foreign timezone absent from installed packs.
    sqlx::query("UPDATE legal_entities SET time_zone='America/New_York' WHERE id=$1")
        .bind(entity)
        .execute(&pool)
        .await
        .unwrap();
    for country in [Value::Null, json!("US")] {
        if !country.is_null() {
            // rls-arming: ok a country pack alone does not adopt another country's rates.
            sqlx::query("INSERT INTO lifecycle_country_packs(country_code,time_zone) VALUES ('US','America/New_York')")
                .execute(&pool).await.unwrap();
        }
        let response = get(service.clone(), &uri(entity), &token).await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.json,
            json!({"country_code":country,"adopted":false,"items":[]})
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rates_validates_required_uuid_and_rejects_anonymous_reads(pool: PgPool) {
    let (service, token, entity, _) = setup(&pool).await;
    assert_eq!(
        get_unauthenticated(service.clone(), &uri(entity)).await,
        StatusCode::UNAUTHORIZED
    );
    for query in [
        "",
        "?legal_entity_id=invalid",
        "?legal_entity_id=",
        "?legal_entity_id=00000000-0000-0000-0000-000000000000&unexpected=1",
    ] {
        let response = get(service.clone(), &format!("{RATES}{query}"), &token).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response.json["error"]["code"], "validation");
    }
}
