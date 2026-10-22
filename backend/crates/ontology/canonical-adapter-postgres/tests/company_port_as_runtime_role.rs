// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Retired writer: fresh facts are refused, N-1 receipts and tenant reads remain.

use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_adapter_postgres::company::{
    CompanyCommand, CompanyError, CompanyHead, CompanyQuery, PgCompanyPort,
};
use console_ontology_canonical_domain::{
    CanonicalPort, CanonicalPortError, CommandId, CommandReceipt, CompanyPort, DispatchTarget,
    ObjectKey, ReceiptOwner,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xc000_0000_0000_0000_0000_0000_0000_0001);

/// The port must satisfy the NAMED trait, not merely `CanonicalPort`. The
/// blanket impl in `canonical-domain` makes `CompanyPort` an alias for
/// `CanonicalPort<Object = Company>`, so this bound stops holding the moment the
/// adapter is retargeted at a different object.
fn assert_implements_company_port<P: CompanyPort>() {}

/// `console_platform_test_support::runtime_role_pool`, inlined: adding that
/// crate as a dev-dependency rewrites this package's entry in
/// `backend/Cargo.lock`, which this lane may not write.
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .expect("connect console_rt-role test pool")
}

/// `console_platform_test_support::seed_org_and_super_admin`, inlined for the
/// same reason. Seeded as the migration owner, before any role switch — which
/// is also the only identity that MAY insert an `organizations` row.
async fn seed_org_and_super_admin(owner_pool: &PgPool, org: Uuid, tag: &str) -> UserId {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{tag}"))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("Admin {tag}"))
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

/// The tenant, its actor, and the port built on a `console_rt` pool.
async fn fixture(owner_pool: &PgPool) -> (OrgId, UserId, PgCompanyPort) {
    let actor = seed_org_and_super_admin(owner_pool, ORG, "company").await;
    let runtime_pool = runtime_role_pool(owner_pool).await;
    let port = PgCompanyPort::new(runtime_pool, tokio::runtime::Handle::current());
    (OrgId::from_uuid(ORG), actor, port)
}

/// Drive the SYNCHRONOUS `execute` off the runtime's worker thread.
async fn execute(
    port: &PgCompanyPort,
    command: CompanyCommand,
) -> Result<CommandReceipt, CompanyError> {
    let port = port.clone();
    tokio::task::spawn_blocking(move || port.execute(&command))
        .await
        .unwrap()
}

async fn get(port: &PgCompanyPort, org: OrgId) -> Result<Option<CompanyHead>, CompanyError> {
    let port = port.clone();
    tokio::task::spawn_blocking(move || port.get(org))
        .await
        .unwrap()
}

async fn list(port: &PgCompanyPort, org: OrgId) -> Result<Vec<CompanyHead>, CompanyError> {
    let port = port.clone();
    tokio::task::spawn_blocking(move || port.list(org))
        .await
        .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn the_runtime_role_may_not_write_the_organizations_head(owner_pool: PgPool) {
    let (_org, _actor, _port) = fixture(&owner_pool).await;

    for verb in ["INSERT", "UPDATE", "DELETE"] {
        let held: bool =
            sqlx::query_scalar("SELECT has_table_privilege('console_rt', 'organizations', $1)")
                .bind(verb)
                .fetch_one(&owner_pool)
                .await
                .unwrap();
        assert!(
            !held,
            "0031 revokes {verb} on organizations from console_rt — provisioning a tenant is an \
             owner operation. A CompanyPort that wrote the head would be dead code in production."
        );
    }
    let held_select: bool =
        sqlx::query_scalar("SELECT has_table_privilege('console_rt', 'organizations', 'SELECT')")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert!(held_select, "the head stays readable to the runtime role");

    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let mut tx = runtime_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let refused = sqlx::query("UPDATE organizations SET name = 'forged' WHERE id = $1")
        .bind(ORG)
        .execute(&mut *tx)
        .await
        .unwrap_err();
    let error = refused.as_database_error().unwrap();
    assert_eq!(error.code().unwrap(), "42501", "got {}", error.message());
    assert_eq!(
        error.message(),
        "permission denied for table organizations",
        "the refusal is the grant layer, beneath RLS"
    );
}

fn command(org: OrgId, actor: UserId, attributes: serde_json::Value) -> CompanyCommand {
    PgCompanyPort::command(
        org,
        CommandId::from_uuid(Uuid::new_v4()),
        actor,
        CompanyQuery { attributes },
        "revise",
        Uuid::nil(),
    )
}

#[test]
fn legal_facts_require_the_legal_entity_record() {
    assert_implements_company_port::<PgCompanyPort>();
    for attributes in [
        json!({"legal_name":"COSS"}),
        json!({"reg_no":"0008167897"}),
        json!({"registration_number":"0008167897"}),
        json!({"display_name":"Tenant"}),
        json!({}),
    ] {
        let check = PgCompanyPort::preflight(&CompanyQuery { attributes });
        assert_eq!(check.code(), Some("legal_entity_record_required"));
        assert!(check.blockers()[0].contains("/org/entities"));
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_second_legal_fact_writer_is_refused(owner: PgPool) {
    let (org, actor, port) = fixture(&owner).await;
    for attributes in [
        json!({"legal_name":"COSS"}),
        json!({"reg_no":"0008167897"}),
        json!({"display_name":"Tenant"}),
    ] {
        let error = execute(&port, command(org, actor, attributes))
            .await
            .unwrap_err();
        assert_eq!(
            error.into_kernel_error().code,
            Some("legal_entity_record_required")
        );
    }
    for (table, sql) in [
        (
            "company_revisions",
            "SELECT count(*) FROM company_revisions WHERE org_id=$1",
        ),
        (
            "ont_action_command_receipts",
            "SELECT count(*) FROM ont_action_command_receipts WHERE org_id=$1",
        ),
        (
            "legal_entities",
            "SELECT count(*) FROM legal_entities WHERE org_id=$1",
        ),
    ] {
        let count: i64 = sqlx::query_scalar(sql)
            .bind(ORG)
            .fetch_one(&owner)
            .await
            .unwrap();
        assert_eq!(count, 0, "refusals may not write {table}");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn n_minus_one_receipt_replays_without_writing_and_tenant_name_has_one_owner(owner: PgPool) {
    let (org, actor, port) = fixture(&owner).await;
    let mut cmd = command(
        org,
        actor,
        json!({"legal_name":"COSS","reg_no":"0008167897"}),
    );
    // This is the N-1 digest contract, including sorted attribute keys.
    let mut hash = Sha256::new();
    hash.update(org.as_uuid().as_bytes());
    hash.update(cmd.command_id.as_uuid().as_bytes());
    hash.update(actor.as_uuid().as_bytes());
    hash.update(b"company.revise");
    hash.update(br#"{"legal_name":"COSS","reg_no":"0008167897"}"#);
    let digest: Vec<u8> = hash.finalize().to_vec();
    let result = json!({"org_id":ORG,"version":1,"target":"company.revise"});
    sqlx::query("INSERT INTO company_revisions (org_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,1,$2,$3,$4,$5,$6)")
        .bind(ORG).bind(cmd.command_id.as_uuid()).bind(actor.as_uuid()).bind(&digest)
        .bind(&cmd.query.attributes).bind(&result).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO ont_action_command_receipts (org_id,command_id,actor_id,payload_digest,receipt,action_key,object_type_id,owner,target,created_at) VALUES ($1,$2,$3,$4,$5,'revise',$6,'company','company.revise',now())")
        .bind(ORG).bind(cmd.command_id.as_uuid()).bind(actor.as_uuid()).bind(&digest)
        .bind(&result).bind(Uuid::nil()).execute(&owner).await.unwrap();
    let replay = execute(&port, cmd.clone()).await.unwrap();
    assert_eq!(replay.result(), &result);
    assert_eq!(replay.owner(), ReceiptOwner::Canonical(ObjectKey::Company));
    assert_eq!(replay.target(), DispatchTarget::CompanyRevise);
    assert_eq!(
        get(&port, org)
            .await
            .unwrap()
            .unwrap()
            .display_name
            .as_deref(),
        Some("Org company")
    );
    assert_eq!(list(&port, org).await.unwrap().len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM company_revisions WHERE org_id=$1")
        .bind(ORG)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(count, 1);
    cmd.query.attributes = json!({"legal_name":"forged"});
    assert!(matches!(
        execute(&port, cmd).await.unwrap_err(),
        CompanyError::DigestConflict(_)
    ));
}

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../platform/db/migrations");
