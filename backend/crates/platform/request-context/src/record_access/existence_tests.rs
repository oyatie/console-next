#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::{access_tests::Fixture, may_read};
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use console_platform_test_support::MIGRATOR;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

#[cfg(test)]
async fn foreign_refs(f: &Fixture) -> Vec<(&'static str, Uuid)> {
    let workplace: Uuid =
        sqlx::query_scalar("SELECT id FROM workplaces WHERE org_id=$1 ORDER BY id LIMIT 1")
            .bind(f.org.as_uuid())
            .fetch_one(&f.owner)
            .await
            .unwrap(); // rls-arming: ok owner fixture
    let registration: Uuid = sqlx::query_scalar("INSERT INTO business_registrations (org_id,legal_entity_id,brn_pending_reason,created_change_mode,created_by) VALUES ($1,$2,'NEW_REGISTRATION_PENDING','SETUP',$3) RETURNING id")
        .bind(f.org.as_uuid()).bind(f.entities[0]).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(f.org.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    let change: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,target_kind,target_ref,target_label,effective_date,reason,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,'OC-2026-0001','NEW','ENTITY','company','Company','2026-10-09','Test',$2,$3,$4) RETURNING id")
        .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).bind(Uuid::new_v4().to_string()).bind("a".repeat(64))
        .fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let policy: Uuid = sqlx::query_scalar("INSERT INTO policy_roles (org_id,role_key,display_name,created_by) VALUES ($1,'record_reader','Record reader',$2) RETURNING id")
        .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let role = f.role().await;
    vec![
        ("legal_entity", f.entities[0]),
        ("workplace", workplace),
        ("business_registration", registration),
        ("org_unit", unit),
        ("org_change_request", change),
        ("tenant", *f.org.as_uuid()),
        ("policy_role", policy),
        ("access_role", role),
        ("access_roles", role),
    ]
}

#[cfg(test)]
#[sqlx::test(migrator = "MIGRATOR")]
async fn current_record_reader_denies_missing_malformed_and_foreign_refs(pool: PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let foreign = Fixture::new(pool).await;
    let p = Principal::new(
        f.actor,
        f.org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    for (kind, other_tenant) in foreign_refs(&foreign).await {
        for id in [
            Uuid::new_v4().to_string(),
            "bad-id".to_owned(),
            other_tenant.to_string(),
        ] {
            for branch in [None, Some(*f.branches[0].as_uuid())] {
                assert!(
                    !may_read(&f.rt, &p, kind, &id, branch).await,
                    "{kind} must exist in the current tenant before current read authority applies"
                );
            }
        }
    }
}

#[cfg(test)]
#[sqlx::test(migrator = "MIGRATOR")]
async fn role_outcome_reader_uses_the_role_api_access_view_floor(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let role = f.role().await;
    f.grant(role, f.reader, Some(f.entities[0])).await;
    let p = f.principal(BranchScope::All);
    for kind in ["access_role", "access_roles"] {
        assert!(
            may_read(&f.rt, &p, kind, &role.to_string(), None).await,
            "the role API permits Access View over some node"
        );
        assert!(!may_read(&f.rt, &p, kind, &Uuid::new_v4().to_string(), None).await);
    }
}

#[cfg(test)]
#[sqlx::test(migrator = "MIGRATOR")]
async fn org_unit_reader_requires_a_recognized_current_head(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let p = Principal::new(
        f.actor,
        f.org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(f.org.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    assert!(may_read(&f.rt, &p, "org_unit", &f.org.to_string(), None).await);
    assert!(!may_read(&f.rt, &p, "org_unit", &unit.to_string(), None).await);
    for (version, kind, readable) in [
        (1, "region", false),
        (2, "site", true),
        (3, "unknown", false),
    ] {
        sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')")
            .bind(f.org.as_uuid()).bind(unit).bind(i64::from(version)).bind(Uuid::new_v4()).bind(f.actor.as_uuid())
            .bind(vec![0u8;32]).bind(serde_json::json!({"kind":kind,"name":"Current unit"}))
            .execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        assert_eq!(
            may_read(&f.rt, &p, "org_unit", &unit.to_string(), None).await,
            readable
        );
    }
}
