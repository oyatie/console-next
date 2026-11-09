// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tracing::{Subscriber, instrument::WithSubscriber};

#[derive(Clone, Default)]
struct QueryCount(Arc<AtomicUsize>);

impl Subscriber for QueryCount {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        if event.metadata().target() == "sqlx::query" {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[cfg(test)]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn view_only_accounts_have_no_approval_candidates_in_one_query(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "candidate-scan").await;
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'조직 조회','ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'조직 조회','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'org',ARRAY['view'])")
        .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
    let accounts: Vec<Uuid> = sqlx::query_scalar("INSERT INTO users(org_id,display_name,roles,is_active) SELECT $1,'Viewer',ARRAY['ADMIN'],true FROM generate_series(1,2000) RETURNING id")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT $1,account,$2,'TENANT',now(),true,'SETUP','TEST',$3 FROM unnest($4::uuid[]) account")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).bind(&accounts).execute(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let queries = QueryCount::default();
    let candidates = approval_candidates_in_tx(&mut tx, org, actor)
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(
        queries.0.load(Ordering::Relaxed),
        1,
        "candidate discovery must stay one query"
    );
    assert!(
        candidates.is_empty(),
        "view grants cannot approve: {} candidates",
        candidates.len()
    );
    tx.rollback().await.unwrap();

    // Neither tenant approval nor a historical org approval line grants this action.
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'tenant',ARRAY['approve'])")
        .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,2,'조직 결재','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,2,'org',ARRAY['approve'])")
        .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert!(
        approval_candidates_in_tx(&mut tx, org, actor)
            .await
            .unwrap()
            .is_empty()
    );
    tx.rollback().await.unwrap();

    sqlx::query("UPDATE access_roles SET version=2 WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE access_grants SET valid_to=now() WHERE account_id=$1")
        .bind(accounts[0])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE account_id=ANY($1::uuid[])")
        .bind(&accounts[1..3]).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(accounts[3])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(accounts[2])
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let candidates = approval_candidates_in_tx(&mut tx, org, actor)
        .await
        .unwrap();
    assert_eq!(candidates.len(), accounts.len() - 3);
    for (index, account) in accounts.iter().enumerate() {
        assert_eq!(candidates.contains(account), index == 2 || index >= 4);
    }
    assert!(!candidates.contains(actor.as_uuid()));
}
