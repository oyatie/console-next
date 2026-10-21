use super::{Fixture, MIGRATOR, OrgId, PgPool, StoredPasskey, Value, origin};
use serde_json::json;
use std::borrow::Cow;
use uuid::Uuid;
use webauthn_rs::prelude::{PasskeyRegistration, RegisterPublicKeyCredential, WebauthnBuilder};

// The pre-0226 schema has no LEDGER audit columns or admission reader. Build its
// real credential with WebAuthn verification and the historical row shape.
pub(super) async fn register_legacy(
    pool: &PgPool,
    user_id: Uuid,
    ceremony_id: Uuid,
    credential: RegisterPublicKeyCredential,
) -> StoredPasskey {
    let state: Value =
        sqlx::query_scalar("SELECT state_json FROM auth_webauthn_ceremonies WHERE id=$1")
            .bind(ceremony_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let state: PasskeyRegistration = serde_json::from_value(state).unwrap();
    let webauthn = WebauthnBuilder::new("example.com", &origin())
        .unwrap()
        .build()
        .unwrap();
    let passkey = webauthn
        .finish_passkey_registration(&credential, &state)
        .unwrap();
    let credential_id = serde_json::to_value(passkey.cred_id())
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO auth_webauthn_credentials (id,user_id,credential_id,passkey_json,org_id) \
         VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(&credential_id)
    .bind(serde_json::to_value(passkey).unwrap())
    .bind(*OrgId::one().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    StoredPasskey {
        id,
        user_id,
        credential_id,
    }
}

pub(super) async fn preserve_upgrade(owner: PgPool, baseline: bool) {
    let baseline_migrator = sqlx::migrate!("../db/baseline");
    // A fresh install applies the baseline and its suffix as the one migration
    // owner (`console_app`, owner of the database) -- 0232 refuses mixed
    // ownership. The historical lineage keeps the bootstrap superuser.
    let mut migration_owner = owner.acquire().await.unwrap().detach();
    if baseline {
        sqlx::query(
            "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO console_app', current_database()); END $$",
        )
        .execute(&owner)
        .await
        .unwrap();
        sqlx::query("SET ROLE console_app")
            .execute(&mut migration_owner)
            .await
            .unwrap();
        baseline_migrator.run(&mut migration_owner).await.unwrap();
        sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,'credential-upgrade','Credential upgrade test')")
            .bind(*OrgId::one().as_uuid()).execute(&owner).await.unwrap();
    } else {
        MIGRATOR.run_to(225, &owner).await.unwrap();
    }
    let mut valid = Fixture::build(owner.clone(), true).await;
    let mut unknown = Fixture::build(owner.clone(), true).await;
    let mut value = unknown.state().await["passkey_json"].clone();
    // Serde ordinarily ignores this extra field; storage admission must not.
    value["cred"]["future_codec"] = json!(6);
    unknown.replace(value).await.unwrap();
    let old_valid = valid.state().await;
    let old_unknown = unknown.state().await;
    let migrator = sqlx::migrate::Migrator {
        migrations: Cow::Owned(if baseline {
            baseline_migrator
                .iter()
                .chain(MIGRATOR.iter().filter(|m| m.version > 225))
                .cloned()
                .collect()
        } else {
            MIGRATOR.iter().cloned().collect()
        }),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    migrator.run(&mut migration_owner).await.unwrap();
    sqlx::Connection::close(migration_owner).await.unwrap();
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(version >= 226, "the actual suffix must have been applied");
    assert_eq!(valid.state().await, old_valid);
    assert_eq!(unknown.state().await, old_unknown);
    let result = sqlx::query(
        "UPDATE auth_webauthn_credentials SET last_used_at=clock_timestamp() WHERE id=$1",
    )
    .bind(unknown.key.id)
    .execute(&unknown.runtime)
    .await;
    assert!(
        result.is_err(),
        "unknown codec denies even timestamp-only changes"
    );
    assert!(unknown.authenticate(false).await.is_err());
    assert_eq!(unknown.state().await, old_unknown);
    valid.authenticate(false).await.unwrap();
}
