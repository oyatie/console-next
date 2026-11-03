// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_concurrent_retries_and_duplicate_names_are_atomic(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let token = account(&pool, &h).await;
    let body = view("동시 저장");
    let key = body["id"].as_str().unwrap();
    let (a, b) = tokio::join!(
        h.call(&token, Some(body.clone()), Some(key)),
        h.call(&token, Some(body.clone()), Some(key))
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert!(
        statuses == [200, 201] || statuses == [201, 409],
        "{statuses:?}"
    );
    assert_eq!(
        h.call(&token, Some(body.clone()), Some(key)).await,
        (StatusCode::OK, body.clone())
    );
    let a = view("중복 저장");
    let b = view("중복 저장");
    let (a, b) = tokio::join!(
        h.call(&token, Some(a.clone()), a["id"].as_str()),
        h.call(&token, Some(b.clone()), b["id"].as_str())
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    let refused = if a.0 == StatusCode::CONFLICT {
        a.1
    } else {
        b.1
    };
    assert_eq!(refused["error"]["code"], "employee_view_name_taken");
    assert_eq!(
        h.call(&token, None, None).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_store_serializes_retries_and_rejects_changed_content(pool: PgPool) {
    use console_identity_adapter_postgres::IdempotentCreate;
    use console_identity_application::EmployeeView;
    use console_platform_request_context::scope_org;
    let h = Harness::new(&pool).await;
    let actor = seed_active_user(&pool, *OrgId::one().as_uuid(), "MEMBER", "Atomic views").await;
    let store = PgOrgStore::new(h.runtime.clone());
    let view: EmployeeView =
        serde_json::from_value(json!({"id":Uuid::new_v4(), "name":"전체 직원", "filters":{}}))
            .unwrap();
    let (a, b) = tokio::join!(
        scope_org(
            OrgId::one(),
            store.create_employee_view(actor, view.clone())
        ),
        scope_org(
            OrgId::one(),
            store.create_employee_view(actor, view.clone())
        ),
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert!(matches!(
        (&a, &b),
        (IdempotentCreate::Created(_), IdempotentCreate::Replay(_))
            | (IdempotentCreate::Replay(_), IdempotentCreate::Created(_))
    ));
    let original = serde_json::to_value(&view).unwrap();
    for response in [a, b] {
        let (IdempotentCreate::Created(value) | IdempotentCreate::Replay(value)) = response;
        assert_eq!(value, original);
    }
    let mut changed = view;
    changed.name = "변경".into();
    let error = scope_org(OrgId::one(), store.create_employee_view(actor, changed))
        .await
        .unwrap_err();
    let console_identity_adapter_postgres::PgOrgError::Domain(error) = error else {
        panic!("expected a coded refusal")
    };
    assert_eq!(error.code, Some("idempotency_key_reused"));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'employee_view.create'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_cedar_snapshot_denies_other_owners_tenants_and_bypass_rls(pool: PgPool) {
    use console_platform_authz::cedar_pbac::visible::load_facts;
    use console_platform_db::{DbError, with_org_conn};
    let h = Harness::new(&pool).await;
    let actor = seed_active_user(&pool, *OrgId::one().as_uuid(), "MEMBER", "Owner").await;
    let other = seed_active_user(&pool, *OrgId::one().as_uuid(), "MEMBER", "Other").await;
    with_org_conn::<_, (), DbError>(&h.runtime, OrgId::one(), |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, OrgId::one(), *actor.as_uuid())
                .await
                .unwrap();
            assert!(
                facts
                    .authorize_employee_view(OrgId::one(), *actor.as_uuid())
                    .unwrap()
            );
            assert!(
                !facts
                    .authorize_employee_view(OrgId::one(), *other.as_uuid())
                    .unwrap()
            );
            assert!(
                !facts
                    .authorize_employee_view(OrgId::new(), *actor.as_uuid())
                    .unwrap()
            );
            Ok(())
        })
    })
    .await
    .unwrap();
    with_org_conn::<_, (), DbError>(&pool, OrgId::one(), |tx| {
        Box::pin(async move {
            assert!(
                load_facts(tx, OrgId::one(), *actor.as_uuid())
                    .await
                    .is_err()
            );
            Ok(())
        })
    })
    .await
    .unwrap();
}
