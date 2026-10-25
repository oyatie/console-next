//! Account allocation/retirement, with actual separately authenticated serving logins.
//! This does not prove enrollment, human identity, auth custody or former-worker retention.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../../../test_support/governed_erase.rs"]
mod governed_erase;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::RefreshTokenStore;
use console_platform_provisioning::{PlatformProvisioner, ProvisioningError, TenantRemovalOutcome};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

const WAIT: std::time::Duration = std::time::Duration::from_secs(8);
#[path = "account_identity/company_removal.rs"]
mod company_removal;
#[path = "account_identity/upgrade.rs"]
mod upgrade;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../db/migrations");

async fn login(owner: &PgPool, force: bool, label: &str) -> PgPool {
    let (role, variable) = if force {
        ("console_platform_force_cmd", "CONSOLE_TEST_FORCE_PASSWORD")
    } else {
        ("console_rt", "CONSOLE_TEST_RUNTIME_PASSWORD")
    };
    let password = std::env::var(variable).expect("disposable role password must be supplied");
    let options = owner
        .connect_options()
        .as_ref()
        .clone()
        .username(role)
        .password(&password)
        .application_name(label);
    // A wrong password must actually fail: trust auth would make this proof invalid.
    assert!(
        PgPoolOptions::new()
            .max_connections(1)
            .connect_with(
                options
                    .clone()
                    .password("deliberately-wrong-local-test-password")
            )
            .await
            .is_err()
    );
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .unwrap();
    let identity: (String, String, bool, bool) = sqlx::query_as("SELECT session_user::text,current_user::text,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user").fetch_one(&pool).await.unwrap();
    assert_eq!(identity, (role.into(), role.into(), false, false));
    pool
}
async fn insert(pool: &PgPool, org: Uuid, id: Uuid) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await?;
    insert_tx(&mut tx, org, id).await?;
    tx.commit().await
}
async fn insert_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO users(id,display_name,roles,org_id) VALUES($1,'Account identity test',ARRAY['MEMBER'],$2)")
        .bind(id).bind(org).execute(&mut **tx).await?;
    Ok(())
}
async fn retired(owner: &PgPool, id: Uuid) -> Option<bool> {
    sqlx::query_scalar(
        "SELECT retired FROM auth_security.account_id_reservations WHERE account_id=$1",
    )
    .bind(id)
    .fetch_optional(owner)
    .await
    .unwrap()
}
fn code(error: &sqlx::Error) -> String {
    error
        .as_database_error()
        .unwrap()
        .code()
        .unwrap()
        .into_owned()
}
#[path = "fixtures/identity_company.rs"]
mod removal_fixture;
use removal_fixture::company;
async fn remove(
    pool: &PgPool,
    force: bool,
    org: Uuid,
    actor: Uuid,
) -> Result<TenantRemovalOutcome, ProvisioningError> {
    let service = PlatformProvisioner::new(Duration::minutes(5));
    if force {
        service
            .force_remove_tenant(
                pool,
                Some(UserId::from_uuid(actor)),
                org,
                OffsetDateTime::now_utc(),
            )
            .await
    } else {
        service
            .remove_tenant(
                pool,
                Some(UserId::from_uuid(actor)),
                org,
                OffsetDateTime::now_utc(),
            )
            .await
    }
}
async fn wait_for_blocker(owner: &PgPool, label: &str, pid: i32) {
    timeout(WAIT, async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND $2=ANY(pg_blocking_pids(pid)))")
                .bind(label).bind(pid).fetch_one(owner).await.unwrap();
            if blocked { break; }
            sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.expect("real uniqueness wait must be observed");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn real_runtime_allocation_and_profile_edits_preserve_identity(owner: PgPool) {
    let rt = login(&owner, false, "identity-runtime").await;
    let org = *OrgId::one().as_uuid();
    let id = Uuid::new_v4();
    insert(&rt, org, id).await.unwrap();
    assert_eq!(retired(&owner, id).await, Some(false));
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(sqlx::query("UPDATE users SET display_name='Changed',phone='01012345678',team='관리',is_active=false WHERE id=$1").bind(id).execute(&mut *tx).await.unwrap().rows_affected(), 1);
    tx.commit().await.unwrap();
    assert_eq!(retired(&owner, id).await, Some(false));
    let missing: i64 = sqlx::query_scalar("SELECT count(*) FROM users u LEFT JOIN auth_security.account_id_reservations r ON r.account_id=u.id WHERE r.account_id IS NULL OR r.retired").fetch_one(&owner).await.unwrap();
    assert_eq!(missing, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn conflict_paths_reserve_only_actual_new_accounts(owner: PgPool) {
    let rt = login(&owner, false, "identity-upsert").await;
    let id = Uuid::new_v4();
    let unused = Uuid::new_v4();
    let org = *OrgId::one().as_uuid();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,org_id,display_name,phone,roles) VALUES($1,$2,'Original','01099998888',ARRAY['MEMBER'])")
        .bind(id)
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(sqlx::query("INSERT INTO users(id,display_name,phone,org_id,roles) VALUES($1,'Ignored','01099998888',$2,ARRAY['MEMBER']) ON CONFLICT DO NOTHING")
        .bind(unused).bind(org).execute(&mut *tx).await.unwrap().rows_affected(), 0);
    let existing: Uuid = sqlx::query_scalar("INSERT INTO users(id,display_name,phone,org_id,roles) VALUES($1,'Updated','01099998888',$2,ARRAY['MEMBER']) ON CONFLICT(phone) WHERE phone IS NOT NULL DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id")
        .bind(unused).bind(org).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(existing, id);
    tx.commit().await.unwrap();
    assert_eq!(retired(&owner, unused).await, None);
    assert_eq!(retired(&owner, id).await, Some(false));
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO users(id,display_name,phone,org_id,roles) VALUES($1,'Relabeled','01099998888',$2,ARRAY['MEMBER']) ON CONFLICT(phone) WHERE phone IS NOT NULL DO UPDATE SET id=EXCLUDED.id")
        .bind(unused).bind(org).execute(&mut *tx).await.unwrap_err();
    assert_eq!(code(&error), "23514");
    tx.rollback().await.unwrap();
    assert_eq!(retired(&owner, unused).await, None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_uuid_and_home_company_are_immutable(owner: PgPool) {
    let rt = login(&owner, false, "identity-immutable").await;
    let id = Uuid::new_v4();
    let org = *OrgId::one().as_uuid();
    insert(&rt, org, id).await.unwrap();
    for query in [
        "UPDATE users SET id=$2 WHERE id=$1",
        "UPDATE users SET org_id=$2 WHERE id=$1",
    ] {
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let err = sqlx::query(query)
            .bind(id)
            .bind(*OrgId::platform().as_uuid())
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(code(&err), "23514");
        tx.rollback().await.unwrap();
    }
    let actual: (Uuid, Uuid) = sqlx::query_as("SELECT id,org_id FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(actual, (id, org));
    assert_eq!(retired(&owner, id).await, Some(false));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn serving_logins_cannot_read_mutate_or_bypass_reservations(owner: PgPool) {
    for force in [false, true] {
        let rt = login(&owner, force, "identity-private").await;
        for query in [
            "SELECT * FROM auth_security.account_id_reservations",
            "INSERT INTO auth_security.account_id_reservations VALUES(gen_random_uuid(),false)",
            "UPDATE auth_security.account_id_reservations SET retired=false",
            "DELETE FROM auth_security.account_id_reservations",
            "TRUNCATE auth_security.account_id_reservations",
            "SELECT auth_security.retire_company_accounts(gen_random_uuid())",
            "ALTER TABLE public.users DISABLE TRIGGER ALL",
            "TRUNCATE public.users CASCADE",
            "SET session_replication_role=replica",
            "SET ROLE console_app",
            "SELECT platform_force_remove_organization(gen_random_uuid())",
        ] {
            let mut tx = rt.begin().await.unwrap();
            let error = sqlx::query(query).execute(&mut *tx).await.expect_err(query);
            assert_eq!(code(&error), "42501", "{query}");
            tx.rollback().await.unwrap();
        }
    }
    let leaked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=ANY(ARRAY['console_rt','console_platform_force_cmd','console_leave_cmd','console_ontology_cmd','console_leave_definer','console_ontology_writer']) AND (has_schema_privilege(r.oid,'auth_security','USAGE') OR has_schema_privilege(r.oid,'auth_security','CREATE') OR has_table_privilege(r.oid,'auth_security.account_id_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,'auth_security.account_id_reservations','SELECT,INSERT,UPDATE,REFERENCES')))").fetch_one(&owner).await.unwrap();
    assert!(!leaked);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deletion_denies_same_transaction_later_and_other_company_reuse(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let id = Uuid::new_v4();
    let rt = login(&owner, false, "identity-reuse").await;
    insert(&rt, org, id).await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        code(&insert_tx(&mut tx, org, id).await.unwrap_err()),
        "23505"
    );
    tx.rollback().await.unwrap();
    assert_eq!(retired(&owner, id).await, Some(false));
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(id)
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(retired(&owner, id).await, Some(true));
    for company in [org, *OrgId::platform().as_uuid()] {
        assert_eq!(code(&insert(&rt, company, id).await.unwrap_err()), "23505");
    }
    assert_eq!(retired(&owner, id).await, Some(true));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_preserves_existing_and_releases_uncommitted_allocation(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let id = Uuid::new_v4();
    let mut tx = owner.begin().await.unwrap();
    insert_tx(&mut tx, org, id).await.unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(retired(&owner, id).await, None);
    insert(&owner, org, id).await.unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(retired(&owner, id).await, Some(false));
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(exists);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stale_snapshots_cannot_reuse_a_committed_retirement(owner: PgPool) {
    for isolation in [
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    ] {
        let rt = login(&owner, false, "identity-old-snapshot").await;
        let org = *OrgId::one().as_uuid();
        let id = Uuid::new_v4();
        insert(&owner, org, id).await.unwrap();
        let mut old = rt.begin().await.unwrap();
        sqlx::query(isolation).execute(&mut *old).await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(&mut *old)
            .await
            .unwrap();
        let visible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
            .bind(id)
            .fetch_one(&mut *old)
            .await
            .unwrap();
        assert!(visible);
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(id)
            .execute(&owner)
            .await
            .unwrap();
        assert_eq!(
            code(&insert_tx(&mut old, org, id).await.unwrap_err()),
            "23505"
        );
        old.rollback().await.unwrap();
        assert_eq!(retired(&owner, id).await, Some(true));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn competing_fresh_allocations_serialize_across_commit_and_rollback(owner: PgPool) {
    for isolation in [
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    ] {
        for commit in [false, true] {
            let org = *OrgId::one().as_uuid();
            let id = Uuid::new_v4();
            let rt = login(&owner, false, "identity-competing-insert").await;
            let mut first = owner.begin().await.unwrap();
            insert_tx(&mut first, org, id).await.unwrap();
            // No users row survives commit, but its UUID must remain allocated.
            sqlx::query("DELETE FROM users WHERE id=$1")
                .bind(id)
                .execute(&mut *first)
                .await
                .unwrap();
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *first)
                .await
                .unwrap();
            let other = tokio::spawn(async move {
                let mut second = rt.begin().await.unwrap();
                sqlx::query(isolation).execute(&mut *second).await.unwrap();
                sqlx::query("SELECT set_config('app.current_org',$1,true)")
                    .bind(org.to_string())
                    .execute(&mut *second)
                    .await
                    .unwrap();
                let absent: bool =
                    sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM users WHERE id=$1)")
                        .bind(id)
                        .fetch_one(&mut *second)
                        .await
                        .unwrap();
                assert!(absent);
                let result = insert_tx(&mut second, org, id).await;
                if result.is_ok() {
                    second.commit().await.unwrap();
                } else {
                    second.rollback().await.unwrap();
                }
                result
            });
            wait_for_blocker(&owner, "identity-competing-insert", pid).await;
            if commit {
                first.commit().await.unwrap();
            } else {
                first.rollback().await.unwrap();
            }
            let result = timeout(WAIT, other).await.unwrap().unwrap();
            if commit {
                assert_eq!(code(&result.unwrap_err()), "23505");
            } else {
                result.unwrap();
            }
            assert_eq!(retired(&owner, id).await, Some(commit));
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn blocked_company_removal_never_retires_live_accounts(owner: PgPool) {
    for force in [false, true] {
        let (org, user, actor) = company(&owner, force).await;
        if force {
            sqlx::query("UPDATE organizations SET status='ACTIVE' WHERE id=$1")
                .bind(org)
                .execute(&owner)
                .await
                .unwrap();
        } else {
            // Exact existing guard: the mere registered-device row prevents removal.
            sqlx::query("INSERT INTO registered_devices(user_id,device_hash,platform,app_version,last_registered_at,org_id) VALUES($1,repeat('a',64),'IOS','1',clock_timestamp(),$2)").bind(user).bind(org).execute(&owner).await.unwrap();
        }
        let before: Value = sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE id=$1")
            .bind(user)
            .fetch_one(&owner)
            .await
            .unwrap();
        let pool = login(&owner, force, "identity-blocked-remove").await;
        if force {
            assert_eq!(
                remove(&pool, true, org, actor).await.unwrap(),
                TenantRemovalOutcome::BlockedActive
            );
        } else {
            let outcome: String =
                sqlx::query_scalar("SELECT public.platform_remove_organization($1)")
                    .bind(org)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(outcome, "blocked_has_data");
        }
        assert_eq!(retired(&owner, user).await, Some(false));
        let after: Value = sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE id=$1")
            .bind(user)
            .fetch_one(&owner)
            .await
            .unwrap();
        assert_eq!(after, before);
    }
}

// Removal evidence records observed rows, not verified enrollment or recovery authority.
async fn removal_key(owner: &PgPool, org: Uuid, user: Uuid, id: Uuid) {
    sqlx::query("INSERT INTO auth_webauthn_credentials(id,user_id,org_id,credential_id,passkey_json,created_at) VALUES($1,$2,$3,$4,'{}','2026-01-01T00:00:00Z')")
        .bind(id).bind(user).bind(org).bind(id.to_string()).execute(owner).await.unwrap();
}
async fn removal_events(owner: &PgPool, key: Uuid) -> Vec<Value> {
    sqlx::query_scalar("SELECT to_jsonb(e) FROM auth_security.credential_removals e WHERE credential_row_id=$1 ORDER BY removed_at,event_id")
        .bind(key).fetch_all(owner).await.unwrap()
}
async fn delete_key(pool: &PgPool, org: Uuid, key: Uuid) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query("DELETE FROM auth_webauthn_credentials WHERE id=$1")
        .bind(key)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(n)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_removal_records_exact_old_metadata_only(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    removal_key(&owner, org, user, key).await;
    let rt = login(&owner, false, "removal-direct").await;
    assert_eq!(
        delete_key(&rt, *OrgId::platform().as_uuid(), key)
            .await
            .unwrap(),
        0
    );
    assert!(removal_events(&owner, key).await.is_empty());
    let before: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(delete_key(&rt, org, key).await.unwrap(), 1);
    let after: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let row: (Uuid, Uuid, Uuid, String, OffsetDateTime, OffsetDateTime) = sqlx::query_as("SELECT credential_row_id,account_id,company_id,credential_id,credential_created_at,removed_at FROM auth_security.credential_removals WHERE credential_row_id=$1").bind(key).fetch_one(&owner).await.unwrap();
    assert_eq!(
        (row.0, row.1, row.2, row.3),
        (key, user, org, key.to_string())
    );
    assert_eq!(row.4.unix_timestamp(), 1767225600);
    assert!(before <= row.5 && row.5 <= after);
    let events = removal_events(&owner, key).await;
    assert_eq!(events.len(), 1);
    let mut columns: Vec<_> = events[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    columns.sort_unstable();
    assert_eq!(
        columns,
        [
            "account_id",
            "company_id",
            "credential_created_at",
            "credential_id",
            "credential_row_id",
            "event_id",
            "removed_at"
        ]
    );
    assert!(Uuid::parse_str(events[0]["event_id"].as_str().unwrap()).is_ok());
    assert_eq!(delete_key(&rt, org, key).await.unwrap(), 0);
    assert_eq!(removal_events(&owner, key).await, events);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn suppressed_and_restrictive_removals_record_no_completed_event(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    removal_key(&owner, org, user, key).await;
    let rt = login(&owner, false, "removal-suppressed").await;
    sqlx::raw_sql("CREATE FUNCTION public.test_suppress_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER test_suppress_removal BEFORE DELETE ON public.auth_webauthn_credentials FOR EACH ROW EXECUTE FUNCTION public.test_suppress_removal();").execute(&owner).await.unwrap();
    assert_eq!(delete_key(&rt, org, key).await.unwrap(), 0);
    assert!(removal_events(&owner, key).await.is_empty());
    sqlx::raw_sql("DROP TRIGGER test_suppress_removal ON public.auth_webauthn_credentials; CREATE TABLE public.test_restricted_key(key UUID REFERENCES public.auth_webauthn_credentials(id) ON DELETE RESTRICT)").execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO test_restricted_key VALUES($1)")
        .bind(key)
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(code(&delete_key(&rt, org, key).await.unwrap_err()), "23001");
    assert!(removal_events(&owner, key).await.is_empty());
    let retained: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_webauthn_credentials WHERE id=$1)")
            .bind(key)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(retained);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn event_failure_and_explicit_rollback_preserve_key_and_history(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    removal_key(&owner, org, user, key).await;
    let rt = login(&owner, false, "removal-rollback").await;
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE id=$1")
        .bind(key)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(removal_events(&owner, key).await.is_empty());
    sqlx::raw_sql("CREATE FUNCTION public.test_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'event_write_failed'; END $$; CREATE TRIGGER test_event_failure BEFORE INSERT ON auth_security.credential_removals FOR EACH ROW EXECUTE FUNCTION public.test_event_failure();").execute(&owner).await.unwrap();
    let error = delete_key(&rt, org, key).await.unwrap_err();
    assert_eq!(code(&error), "P0001");
    assert!(error.to_string().contains("event_write_failed"));
    let retained: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_webauthn_credentials WHERE id=$1)")
            .bind(key)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(retained);
    assert!(removal_events(&owner, key).await.is_empty());
    sqlx::raw_sql("DROP TRIGGER test_event_failure ON auth_security.credential_removals")
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(delete_key(&rt, org, key).await.unwrap(), 1);
    assert_eq!(removal_events(&owner, key).await.len(), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn repeated_row_identity_removals_append_distinct_events(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    let rt = login(&owner, false, "removal-repeat").await;
    removal_key(&owner, org, user, key).await;
    delete_key(&rt, org, key).await.unwrap();
    let first = removal_events(&owner, key).await;
    assert_eq!(first.len(), 1);
    // Maintenance fixture reuses row identity to prove no evidence UPSERT/loss.
    // This is not authorization for production credential resurrection.
    removal_key(&owner, org, user, key).await;
    delete_key(&rt, org, key).await.unwrap();
    let events = removal_events(&owner, key).await;
    assert_eq!(events.len(), 2);
    assert!(events.contains(&first[0]));
    assert_ne!(events[0]["event_id"], events[1]["event_id"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn credential_removal_never_locks_account_or_reservation(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    removal_key(&owner, org, user, key).await;
    let rt = login(&owner, false, "removal-no-root-lock").await;
    let mut held = owner.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT account_id FROM auth_security.account_id_reservations WHERE account_id=$1 FOR UPDATE").bind(user).fetch_one(&mut *held).await.unwrap();
    assert_eq!(
        timeout(WAIT, delete_key(&rt, org, key))
            .await
            .expect("DELETE must complete while root locks remain held")
            .unwrap(),
        1
    );
    assert_eq!(removal_events(&owner, key).await.len(), 1);
    held.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn private_removal_evidence_denies_serving_forgery_and_truncation(owner: PgPool) {
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('auth_security.credential_removals') IS NOT NULL")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(exists);
    let leaked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=ANY(ARRAY['console_rt','console_platform_force_cmd','console_leave_cmd','console_ontology_cmd','console_leave_definer','console_ontology_writer']) AND (has_schema_privilege(r.oid,'auth_security','USAGE,CREATE') OR has_table_privilege(r.oid,'auth_security.credential_removals','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,'auth_security.credential_removals','SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(r.oid,'public.auth_webauthn_credentials','TRUNCATE') OR has_function_privilege(r.oid,'auth_security.record_credential_removal()','EXECUTE')))").fetch_one(&owner).await.unwrap();
    assert!(!leaked);
    for force in [false, true] {
        let rt = login(&owner, force, "removal-denied").await;
        for query in [
            "SELECT * FROM auth_security.credential_removals",
            "INSERT INTO auth_security.credential_removals DEFAULT VALUES",
            "UPDATE auth_security.credential_removals SET removed_at=clock_timestamp()",
            "DELETE FROM auth_security.credential_removals",
            "TRUNCATE auth_security.credential_removals",
            "TRUNCATE public.auth_webauthn_credentials CASCADE",
            "SELECT auth_security.record_credential_removal()",
            "ALTER TABLE public.auth_webauthn_credentials DISABLE TRIGGER ALL",
            "CREATE TRIGGER test_forged_removal AFTER DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION auth_security.record_credential_removal()",
        ] {
            let mut tx = rt.begin().await.unwrap();
            let error = sqlx::query(query).execute(&mut *tx).await.expect_err(query);
            assert_eq!(code(&error), "42501", "{query}");
            tx.rollback().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reset_owner_removal_and_late_audit_failure_are_atomic(owner: PgPool) {
    use console_platform_provisioning::BootstrapCredentialStore;
    let org = *OrgId::one().as_uuid();
    let user = Uuid::new_v4();
    let key = Uuid::new_v4();
    insert(&owner, org, user).await.unwrap();
    removal_key(&owner, org, user, key).await;
    let rt = login(&owner, false, "removal-reset").await;
    sqlx::raw_sql("CREATE FUNCTION public.test_removal_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='auth.passkey.admin_reset' THEN RAISE EXCEPTION 'removal_audit_failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_removal_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.test_removal_audit_failure();").execute(&owner).await.unwrap();
    let error = BootstrapCredentialStore
        .reset_credentials_for_user(
            &rt,
            UserId::from_uuid(user),
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::minutes(5),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("removal_audit_failed"));
    assert!(removal_events(&owner, key).await.is_empty());
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE id=$1),(SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$2),(SELECT count(*) FROM audit_events WHERE actor=$2)").bind(key).bind(user).fetch_one(&owner).await.unwrap();
    assert_eq!(counts, (1, 0, 0));
    sqlx::raw_sql("DROP TRIGGER test_removal_audit_failure ON public.audit_events")
        .execute(&owner)
        .await
        .unwrap();
    BootstrapCredentialStore
        .reset_credentials_for_user(
            &rt,
            UserId::from_uuid(user),
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::minutes(5),
        )
        .await
        .unwrap();
    assert_eq!(removal_events(&owner, key).await.len(), 1);
}
