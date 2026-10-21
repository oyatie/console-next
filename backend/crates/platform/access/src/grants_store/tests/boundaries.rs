// SPDX-License-Identifier: LicenseRef-Proprietary
//! Non-elevated near miss and tenant-configured delay, separate from grant age.
use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn view_only_grant_does_not_enter_the_elevated_delay(pool: PgPool) {
    let (org, actor, target, _) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let role = Uuid::new_v4();
    let lines = [LineOut {
        domain: Domain::Org,
        levels: vec![Level::View],
    }];
    let fields = VersionFields {
        name_ko: "조회",
        name_en: None,
        description: None,
        status: "ACTIVE",
        change_mode: "SETUP",
        reason_code: None,
        reason_note: None,
        lines: &lines,
    };
    insert_head(&mut tx, org, role, actor, &fields)
        .await
        .unwrap();
    insert_version(&mut tx, org, role, 1, actor, &fields)
        .await
        .unwrap();
    let now = OffsetDateTime::now_utc();
    let row = GrantRow {
        id: Uuid::new_v4(),
        account_id: target,
        role_id: role,
        kind: NodeKind::Tenant,
        node_id: None,
        valid_from: now,
        valid_to: None,
        revoked: false,
        effective_in_setup: true,
    };
    insert(
        &mut tx,
        org,
        &NewGrant {
            row: &row,
            change_mode: "SETUP",
            reason_code: "PROMOTION_OR_REASSIGNMENT",
            reason_note: None,
            granted_by: actor,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        load_access_subject(&mut tx, org, target, now)
            .await
            .unwrap()
            .grants
            .len(),
        1
    );
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_role_grants_pending WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(pending, 0);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn configured_solo_delay_is_not_the_minimum_second_person_age(pool: PgPool) {
    use console_kernel_core::FixedClock;
    use console_settings_domain::SettingKey;
    use time::Duration;
    let (org, actor, _, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let mut now = OffsetDateTime::now_utc();
    for (key, value) in [
        (SettingKey::AuthzElevatedGrantSoleAdminDelay, 48),
        (SettingKey::AuthzSecondPersonMinGrantAge, 13),
    ] {
        now = sqlx::query_scalar("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,$2,$3,$4,'POLICY') RETURNING effective_from")
            .bind(org.as_uuid()).bind(key.as_str()).bind(serde_json::json!(value)).bind(actor).fetch_one(tx.as_mut()).await.unwrap();
    }
    let due = crate::pending::deadline(&mut tx, org, role, &FixedClock(now))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(due, now + Duration::hours(48));
    assert_ne!(due, now + Duration::days(13));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn setup_elevated_grant_applies_immediately_without_a_pending_row(pool: PgPool) {
    let (org, actor, target, role) = fixture_in_setup(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let now = OffsetDateTime::now_utc();
    let row = GrantRow {
        id: Uuid::new_v4(),
        account_id: target,
        role_id: role,
        kind: NodeKind::Tenant,
        node_id: None,
        valid_from: now,
        valid_to: None,
        revoked: false,
        effective_in_setup: true,
    };
    insert(
        &mut tx,
        org,
        &NewGrant {
            row: &row,
            change_mode: "SETUP",
            reason_code: "PROMOTION_OR_REASSIGNMENT",
            reason_note: None,
            granted_by: actor,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        load_access_subject(&mut tx, org, target, now)
            .await
            .unwrap()
            .grants
            .len(),
        1
    );
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_role_grants_pending WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(pending, 0);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn preview_exposes_the_computed_deadline_only_for_delayed_grants(pool: PgPool) {
    use console_kernel_core::{BranchScope, UserId};
    use console_platform_authz::Principal;
    use time::format_description::well_known::Rfc3339;
    for setup in [false, true] {
        let (org, actor, target, role) = if setup {
            fixture_in_setup(&pool).await
        } else {
            fixture(&pool).await
        };
        let service = crate::AccessService::new(pool.clone(), None);
        let principal = Principal::new(
            UserId::from_uuid(actor),
            org,
            Default::default(),
            BranchScope::All,
        )
        .with_tenant_ops(true);
        let before = OffsetDateTime::now_utc();
        let preview = crate::grants::preview(&service, principal, serde_json::from_value(serde_json::json!({
            "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": [{
                "op": "grant", "account_id": target, "role_id": role,
                "scope": {"kind": "TENANT", "include_descendants": true}, "effective_in_setup": true
            }]
        })).unwrap()).await.unwrap();
        assert_eq!(preview["refused"], 0, "{preview}");
        let item = &preview["items"][0];
        assert_eq!(
            item["enforcement_after"],
            if setup { "ENFORCED" } else { "SCHEDULED" }
        );
        if setup {
            assert!(item["activates_at"].is_null());
        } else {
            let at = OffsetDateTime::parse(
                item["activates_at"].as_str().expect("scheduled deadline"),
                &Rfc3339,
            )
            .unwrap();
            assert!(at > before);
        }
    }
}
