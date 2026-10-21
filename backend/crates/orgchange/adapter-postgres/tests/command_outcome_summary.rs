#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Home's waiting row links the latest successful request command, never another tenant's.
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, AuditOutcome, OrgId, TraceContext, UserId,
};
use console_orgchange_adapter_postgres::{ListFilter, PgOrgChangeStore};
use console_platform_db::{
    DbError, command_context,
    command_outcomes::{self, Reservation},
    with_audit,
};
use console_platform_request_context::scope_org;
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn tenant(pool: &PgPool) -> (OrgId, UserId) {
    let org = OrgId::new();
    let actor = UserId::new();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Summary tenant')")
        .bind(org.as_uuid())
        .bind(format!("summary-{}", org.as_uuid().simple()))
        .execute(pool)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Summary actor',ARRAY['SUPER_ADMIN'])")
        .bind(actor.as_uuid()).bind(org.as_uuid()).execute(pool).await.unwrap(); // rls-arming: ok owner fixture
    (org, actor)
}
async fn audit(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    target: Uuid,
    outcome: AuditOutcome,
    at: OffsetDateTime,
    ledger: bool,
) -> Option<Uuid> {
    let id = if ledger {
        match command_outcomes::reserve(
            pool,
            org,
            actor,
            Uuid::new_v4().to_string(),
            "POST /api/v1/org-changes/submit".into(),
            vec![1],
            json!({"masked":true}),
        )
        .await
        .unwrap()
        {
            Reservation::Fresh(id) => Some(id),
            _ => panic!("fresh identity"),
        }
    } else {
        None
    };
    let mut context = AuditCommandContext::for_actor(Some(actor));
    context.org_id = Some(org);
    context.command_id = id;
    context.outcome = outcome;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("org_change.submit").unwrap(),
        "org_change_request",
        target.to_string(),
        TraceContext::generate(),
        at,
    )
    .with_org(org)
    .with_command_context(context.clone());
    if outcome == AuditOutcome::Denied {
        command_outcomes::settle_refused(
            pool,
            org,
            id.unwrap(),
            "REFUSED".into(),
            "forbidden".into(),
            event,
        )
        .await
        .unwrap();
    } else {
        command_context::scope(
            context,
            with_audit::<_, _, DbError>(pool, event, |_| Box::pin(async { Ok(()) })),
        )
        .await
        .unwrap();
    }
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn summary_links_latest_success_and_excludes_denied_legacy_and_foreign_audits(pool: PgPool) {
    let (org, actor) = tenant(&pool).await;
    let (other, other_actor) = tenant(&pool).await;
    let target:Uuid=sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0001','NEW','IN_APPROVAL','ENTITY','company','Company','2026-10-09','Test',$2,$3,$4) RETURNING id")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(Uuid::new_v4().to_string()).bind("a".repeat(64)).fetch_one(&pool).await.unwrap(); // rls-arming: ok owner fixture
    let runtime = PgPoolOptions::new()
        .max_connections(3)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let store = PgOrgChangeStore::new(runtime);
    scope_org(org, async {
        let filter = ListFilter {
            drafted_by: Some(*actor.as_uuid()),
            ..Default::default()
        };
        assert_eq!(
            store.list(filter.clone()).await.unwrap().items[0].command_id,
            None
        );
        let start = OffsetDateTime::now_utc();
        audit(
            &pool,
            org,
            actor,
            target,
            AuditOutcome::Allowed,
            start,
            true,
        )
        .await;
        let latest = audit(
            &pool,
            org,
            actor,
            target,
            AuditOutcome::Allowed,
            start + Duration::seconds(1),
            true,
        )
        .await;
        audit(
            &pool,
            org,
            actor,
            target,
            AuditOutcome::Denied,
            start + Duration::seconds(2),
            true,
        )
        .await;
        audit(
            &pool,
            org,
            actor,
            target,
            AuditOutcome::Allowed,
            start + Duration::seconds(3),
            false,
        )
        .await;
        audit(
            &pool,
            other,
            other_actor,
            target,
            AuditOutcome::Allowed,
            start + Duration::seconds(4),
            true,
        )
        .await;
        let page = store.list(filter).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].command_id, latest);
        let detail = store.get(target).await.unwrap();
        assert_eq!(detail.summary.command_id, latest);
        assert_eq!(detail.summary.code, "OC-2026-0001");
        assert_eq!(detail.summary.drafted_by, *actor.as_uuid());
        assert_eq!(detail.summary.target.label, "Company");
    })
    .await;
}
