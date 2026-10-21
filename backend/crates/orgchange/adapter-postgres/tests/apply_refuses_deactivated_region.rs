#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Decisions #18 at apply time. 지역 and 지점 are retired as separate
//! concepts and a 사업장 is created through its 법인, so a request stored
//! before the retirement (CreateRegion / CreateBranch / RenameBranch, or a
//! bare SITE CreateOrgUnit) cannot apply even once APPROVED, and nothing is
//! written. Closing a legacy branch still applies, but never the branch that
//! backs a live 사업장 (it closes with its 사업장).
//!
//! Driven through `PgOrgChangeStore::effectuate` (the shipped apply entry
//! point). Requests are seeded `APPROVED` so the oracle isolates the apply
//! transaction. (Formerly the console-k6wm deactivated-region probe: both of
//! its ops are now refused before any region is read.)

use console_kernel_core::{OrgId, UserId};
use console_orgchange_adapter_postgres::{PgOrgChangeError, PgOrgChangeStore};
use console_orgchange_domain::{
    BRANCH_BACKS_WORKPLACE, OrgChangeStatus, OrgProposalOp, OrgUnitKind, REGION_BRANCH_RETIRED,
    SITE_NEEDS_WORKPLACE,
};
use sqlx::{PgPool, Row};
use time::{Date, OffsetDateTime, macros::offset};
use uuid::Uuid;

fn today_kst() -> Date {
    OffsetDateTime::now_utc().to_offset(offset!(+9)).date()
}

fn refusal_code(result: Result<impl std::fmt::Debug, PgOrgChangeError>) -> Option<&'static str> {
    match result {
        Err(PgOrgChangeError::Domain(e)) => e.code,
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn effectuate_refuses_ops_retired_by_decisions_18(pool: PgPool) {
    let org = seed_org(&pool).await;
    console_platform_request_context::scope_org(org, async move {
        let actor = seed_user(&pool, org, "EXECUTIVE").await;
        let region = seed_region(&pool, org, "활성권역").await;
        let branch = seed_branch(&pool, org, region, "실지점").await;
        let store = PgOrgChangeStore::new(pool.clone());
        let cases = [
            (
                "r18-retired-create-branch-0001",
                OrgProposalOp::CreateBranch {
                    region_id: region,
                    name: "유령지점".into(),
                },
                REGION_BRANCH_RETIRED,
            ),
            (
                "r18-retired-create-region-0001",
                OrgProposalOp::CreateRegion {
                    name: "유령권역".into(),
                },
                REGION_BRANCH_RETIRED,
            ),
            (
                "r18-retired-rename-branch-0001",
                OrgProposalOp::RenameBranch {
                    branch_id: branch,
                    name: Some("개명지점".into()),
                    region_id: None,
                },
                REGION_BRANCH_RETIRED,
            ),
            (
                "r18-retired-bare-site-0001",
                OrgProposalOp::CreateOrgUnit {
                    kind: OrgUnitKind::Site,
                    parent_id: None,
                    name: "본사".into(),
                },
                SITE_NEEDS_WORKPLACE,
            ),
        ];
        for (key, op, code) in cases {
            let id = seed_approved(&pool, org, actor, region, key, vec![op]).await;
            assert_eq!(
                refusal_code(store.effectuate(actor, id, true).await),
                Some(code),
                "{key}"
            );
            assert_eq!(
                request_status(&pool, org, id).await,
                "APPROVED",
                "{key}: nothing applied"
            );
        }
        assert_eq!(branch_count_by_name(&pool, org, "유령지점").await, 0);
        assert_eq!(branch_count_by_name(&pool, org, "개명지점").await, 0);
        assert_eq!(branch_region(&pool, org, branch).await, region);
    })
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_that_backs_a_workplace_closes_only_with_it(pool: PgPool) {
    let org = seed_org(&pool).await;
    console_platform_request_context::scope_org(org, async move {
        let actor = seed_user(&pool, org, "EXECUTIVE").await;
        let region = seed_region(&pool, org, "권역").await;
        let backing = seed_branch(&pool, org, region, "공장지점").await;
        let orphan = seed_branch(&pool, org, region, "옛지점").await;
        seed_workplace(&pool, org, backing).await;
        let store = PgOrgChangeStore::new(pool.clone());

        let refused = seed_approved(
            &pool,
            org,
            actor,
            region,
            "r18-close-backing-branch-0001",
            vec![OrgProposalOp::DeactivateBranch { branch_id: backing }],
        )
        .await;
        assert_eq!(
            refusal_code(store.effectuate(actor, refused, true).await),
            Some(BRANCH_BACKS_WORKPLACE)
        );
        assert_eq!(request_status(&pool, org, refused).await, "APPROVED");

        let closed = seed_approved(
            &pool,
            org,
            actor,
            region,
            "r18-close-orphan-branch-0001",
            vec![OrgProposalOp::DeactivateBranch { branch_id: orphan }],
        )
        .await;
        let applied = store
            .effectuate(actor, closed, true)
            .await
            .expect("a legacy branch with no 사업장 still closes");
        assert_eq!(applied.summary.status, OrgChangeStatus::Applied);
    })
    .await;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn seed_org(pool: &PgPool) -> OrgId {
    let slug = format!("k6{}", &Uuid::new_v4().simple().to_string()[..12]);
    let id: Uuid =
        sqlx::query_scalar("INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id")
            .bind(&slug)
            .bind(format!("org-{slug}"))
            .fetch_one(pool)
            .await
            .unwrap();
    OrgId::from_uuid(id)
}

async fn seed_region(pool: &PgPool, org: OrgId, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
        .bind(name)
        .bind(*org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn seed_branch(pool: &PgPool, org: OrgId, region: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region)
    .bind(name)
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_user(pool: &PgPool, org: OrgId, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, $2, $3, true, $4)",
    )
    .bind(*user.as_uuid())
    .bind(format!("k6wm-{user}"))
    .bind(vec![role])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    user
}

/// Insert a request already in `APPROVED` so effectuate exercises apply_ops
/// without the SoD chain. Fingerprint is a valid 64-hex sha; proposal JSON is
/// the typed `OrgProposalOp` wire shape.
async fn seed_approved(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    target_region: Uuid,
    idempotency_key: &str,
    proposal: Vec<OrgProposalOp>,
) -> Uuid {
    let id = Uuid::new_v4();
    let proposal_json = serde_json::to_value(&proposal).unwrap();
    let fingerprint = format!("{:064x}", id.as_u128());
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Mirror the production allocator instead of truncating a UUID into a
    // collision-prone four-digit fixture code. Calls in this story are
    // sequential and the tenant-armed transaction sees every prior seed.
    let year = today_kst().year();
    let prefix = format!("OC-{year}-");
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT max((substring(code FROM 9))::bigint) \
         FROM org_change_requests WHERE code LIKE $1",
    )
    .bind(format!("{prefix}%"))
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    let code = format!("{prefix}{:04}", last.unwrap_or(0) + 1);
    sqlx::query(
        "INSERT INTO org_change_requests \
         (id, org_id, code, kind, status, target_kind, target_ref, target_label, \
          effective_date, reason, proposal, drafted_by, idempotency_key, request_fingerprint) \
         VALUES ($1,$2,$3,'REORG','APPROVED','REGION',$4,$5,$6,$7,$8,$9,$10,$11)",
    )
    .bind(id)
    .bind(*org.as_uuid())
    .bind(&code)
    .bind(target_region.to_string())
    .bind("k6wm deactivated-region probe")
    .bind(today_kst())
    .bind("console-k6wm apply inverse guard")
    .bind(&proposal_json)
    .bind(*actor.as_uuid())
    .bind(idempotency_key)
    .bind(&fingerprint)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// A 사업장 backed by `branch` (minimal MIGRATION-mode rows).
async fn seed_workplace(pool: &PgPool, org: OrgId, branch: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let entity: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities (org_id, biz_kind, created_change_mode) \
         VALUES ($1, 'CORPORATION', 'MIGRATION') RETURNING id",
    )
    .bind(*org.as_uuid())
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workplaces (org_id, legal_entity_id, default_branch_id, created_change_mode) \
         VALUES ($1, $2, $3, 'MIGRATION')",
    )
    .bind(*org.as_uuid())
    .bind(entity)
    .bind(branch)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn branch_count_by_name(pool: &PgPool, org: OrgId, name: &str) -> i64 {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM branches WHERE name = $1")
        .bind(name)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    count
}

async fn branch_region(pool: &PgPool, org: OrgId, branch_id: Uuid) -> Uuid {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let region: Uuid = sqlx::query_scalar("SELECT region_id FROM branches WHERE id = $1")
        .bind(branch_id)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    region
}

async fn request_status(pool: &PgPool, org: OrgId, id: Uuid) -> String {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let row = sqlx::query("SELECT status FROM org_change_requests WHERE id = $1")
        .bind(id)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    let status: String = row.try_get("status").unwrap();
    tx.commit().await.unwrap();
    status
}
