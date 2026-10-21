//! Preservation proof from the historical account schema through current migrations.
use super::*;

#[sqlx::test(migrations = false)]
async fn actual_0227_upgrade_preserves_every_account_key_and_family(owner: PgPool) {
    MIGRATOR.run_to(227, &owner).await.unwrap();
    let id = Uuid::new_v4();
    insert(&owner, *OrgId::one().as_uuid(), id).await.unwrap();
    sqlx::query("INSERT INTO auth_webauthn_credentials(user_id,credential_id,passkey_json,org_id) VALUES($1,$2,'{}',$3)").bind(id).bind(id.to_string()).bind(*OrgId::one().as_uuid()).execute(&owner).await.unwrap();
    // Seed under the historical schema; today's audit envelope needs later migrations.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::one().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (issued, _) = RefreshTokenStore
        .issue_family_in_tx(
            &mut tx,
            id,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::minutes(5),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // `is_tenant_ops` is a later column (decision #26; its backfill has its own test), as are
    // 20261013153727436's family activity columns (INF-03).
    let snapshot = "SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u) - 'is_tenant_ops' ORDER BY id) FROM users u),'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM auth_webauthn_credentials k),'families',(SELECT jsonb_agg(to_jsonb(f) - 'last_activity_at' - 'idle_timeout_minutes' ORDER BY id) FROM auth_refresh_token_families f),'bootstrap',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM auth_bootstrap_credentials b))";
    let before: Value = sqlx::query_scalar(snapshot)
        .fetch_one(&owner)
        .await
        .unwrap();
    // 0230 expands families with provenance columns; a pre-existing family keeps
    // every 0227 value and takes the legacy version-0 shape (all source fields NULL).
    let mut expected = before.clone();
    for family in expected["families"].as_array_mut().unwrap() {
        let family = family.as_object_mut().unwrap();
        family.insert("provenance_version".into(), Value::from(0));
        for column in [
            "auth_generation",
            "session_purpose",
            "source_kind",
            "source_operation_id",
        ] {
            family.insert(column.into(), Value::Null);
        }
    }
    MIGRATOR.run(&owner).await.unwrap();
    let after: Value = sqlx::query_scalar(snapshot)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(after, expected);
    let matching: bool = sqlx::query_scalar("SELECT (SELECT array_agg(id ORDER BY id) FROM users)=(SELECT array_agg(account_id ORDER BY account_id) FROM auth_security.account_id_reservations WHERE NOT retired)").fetch_one(&owner).await.unwrap();
    assert!(matching);
    assert_eq!(retired(&owner, id).await, Some(false));
    MIGRATOR.run(&owner).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, Value>(snapshot)
            .fetch_one(&owner)
            .await
            .unwrap(),
        expected
    );
    let rotated = RefreshTokenStore
        .rotate(
            &owner,
            issued.token.as_str(),
            OffsetDateTime::now_utc(),
            Duration::minutes(5),
            Duration::days(1),
        )
        .await
        .unwrap();
    assert_eq!(rotated.family_id, issued.family_id);
    assert_eq!(rotated.user_id, id);
}
