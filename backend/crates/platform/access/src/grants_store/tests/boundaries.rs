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
    for (key, value) in [
        (SettingKey::AuthzElevatedGrantSoleAdminDelay, 48),
        (SettingKey::AuthzSecondPersonMinGrantAge, 13),
    ] {
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code,effective_from) VALUES ($1,$2,$3,$4,'POLICY',now())")
            .bind(org.as_uuid()).bind(key.as_str()).bind(serde_json::json!(value)).bind(actor).execute(tx.as_mut()).await.unwrap();
    }
    let now = OffsetDateTime::now_utc();
    let due = crate::pending::deadline(&mut tx, org, role, &FixedClock(now))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(due, now + Duration::hours(48));
    assert_ne!(due, now + Duration::days(13));
}
