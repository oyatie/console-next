// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stale_expected_version_is_409_and_compares_now_not_scheduled_value(pool: PgPool) {
    let (org, service, token) = fixture(&pool).await;
    let write = |value| json!({"value": value, "reason_code": "POLICY_REVIEW"});
    let (status, current) = send(&service, "POST", PATH, Some(&token), Some(write(20))).await;
    assert_eq!(status, StatusCode::CREATED, "{current}");
    let version = json!({"override": current["id"]});
    let later = time::OffsetDateTime::now_utc() + time::Duration::days(2);
    let mut scheduled = write(10);
    scheduled["effective_from"] = json!(
        later
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    );
    let (status, future) = send(&service, "POST", PATH, Some(&token), Some(scheduled)).await;
    assert_eq!(status, StatusCode::CREATED, "{future}");
    let before = counts(&pool, org).await.0;
    let mut change = write(5);
    change["effective_from"] = json!(
        (later + time::Duration::days(1))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    );
    for stale in [
        json!("code_default"),
        json!({"override": Uuid::new_v4()}),
        json!({"override": future["id"]}),
    ] {
        change["expected_version"] = stale;
        let mut errors = Vec::new();
        for query in ["?dry_run=true", ""] {
            let (status, body) = send(
                &service,
                "POST",
                &format!("{PATH}{query}"),
                Some(&token),
                Some(change.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["error"]["code"], "setting_version_stale");
            assert_eq!(body["error"]["current_version"], version);
            errors.push(json!({"code": body["error"]["code"], "message": body["error"]["message"],
                "errors": body["error"]["errors"], "current_version": body["error"]["current_version"]}));
        }
        assert_eq!(errors[0], errors[1]);
        assert_eq!(counts(&pool, org).await.0, before);
    }
    // A scheduled tightening must not turn a stale request into a passkey prompt.
    change["value"] = json!(15);
    change["expected_version"] = json!("code_default");
    for query in ["?dry_run=true", ""] {
        let (status, body) = send(
            &service,
            "POST",
            &format!("{PATH}{query}"),
            Some(&token),
            Some(change.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "setting_version_stale");
    }
    change["value"] = json!(5);
    change["expected_version"] = version.clone();
    let (status, plan) = send(
        &service,
        "POST",
        &format!("{PATH}?dry_run=true"),
        Some(&token),
        Some(change.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{plan}");
    assert_eq!(
        plan["in_force"],
        json!({"value": 20, "version": version, "scope_entity_id": null})
    );
    let (status, body) = send(&service, "POST", PATH, Some(&token), Some(change)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_explains_default_inherited_and_own_values_and_reach_at_effective_date(
    pool: PgPool,
) {
    let (org, service, token) = fixture(&pool).await;
    let preview_path = format!("{PATH}?dry_run=true");
    let change = |value, scope| json!({"value": value, "scope_entity_id": scope, "reason_code": "POLICY_REVIEW"});
    let (_, plan) = send(
        &service,
        "POST",
        &preview_path,
        Some(&token),
        Some(change(20, None::<Uuid>)),
    )
    .await;
    assert_eq!(
        plan["in_force"],
        json!({"value": 30, "version": "code_default", "scope_entity_id": null})
    );
    assert_eq!(
        plan["reaches"],
        json!({"scope_entity_id": null, "keeps_own_value": []})
    );
    let granter = seed_user(&pool, org, "SUPER_ADMIN").await;
    let a = seed_legal_entity(&pool, org, granter).await;
    let b = seed_legal_entity(&pool, org, granter).await;
    let (status, tenant) = send(&service, "POST", PATH, Some(&token), Some(change(20, None))).await;
    assert_eq!(status, StatusCode::CREATED, "{tenant}");
    let (status, own) = send(
        &service,
        "POST",
        PATH,
        Some(&token),
        Some(change(10, Some(a))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{own}");
    // Two rows at A still contribute one scope; B's row starts after the preview date.
    for (scope, days, value) in [(a, 1, 8), (b, 4, 5)] {
        let mut body = change(value, Some(scope));
        body["effective_from"] = json!(
            (time::OffsetDateTime::now_utc() + time::Duration::days(days))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        );
        let (status, saved) = send(&service, "POST", PATH, Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{saved}");
    }
    let before = counts(&pool, org).await;
    for scope in [None, Some(a), Some(b)] {
        let mut body = change(5, scope);
        body["effective_from"] = json!(
            (time::OffsetDateTime::now_utc() + time::Duration::days(2))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        );
        let (status, plan) = send(&service, "POST", &preview_path, Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{plan}");
        let (value, version, source) = if scope == Some(a) {
            (10, &own["id"], Some(a))
        } else {
            (20, &tenant["id"], None)
        };
        assert_eq!(
            plan["in_force"],
            json!({"value": value, "version": {"override": version}, "scope_entity_id": source})
        );
        assert_eq!(
            plan["reaches"],
            json!({"scope_entity_id": scope, "keeps_own_value": if scope.is_none() { vec![a] } else { vec![] }})
        );
        assert_eq!(counts(&pool, org).await, before);
    }
}
