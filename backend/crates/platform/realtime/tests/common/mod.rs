//! Helpers shared by the Postgres-backed change-stream tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::time::Duration;

use console_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, OrgId, TraceContext, UserId,
};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal};
use console_platform_db::{DbError, with_audits};
use console_platform_realtime::{RealtimeConnection, RealtimeEvent};
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::time::timeout;

pub fn event(
    org: OrgId,
    target: (&str, &str),
    action: &str,
    branch: Option<BranchId>,
) -> AuditEvent {
    let event = AuditEvent::new(
        None,
        AuditAction::new(action).unwrap(),
        target.0,
        target.1,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);
    match branch {
        Some(branch) => event.with_branch(branch),
        None => event,
    }
}

/// Commits `events` in ONE audited transaction (the production write path).
pub async fn commit(pool: &PgPool, org: OrgId, events: Vec<AuditEvent>) {
    with_audits::<_, _, DbError>(pool, org, move |_tx| {
        Box::pin(async move { Ok(((), events)) })
    })
    .await
    .unwrap();
}

pub fn reader(org: OrgId, features: &[Feature], scope: BranchScope) -> Principal {
    let grants = features
        .iter()
        .map(|f| EffectiveFeatureGrant::new(*f, PermissionLevel::Allow, scope.clone()))
        .collect();
    Principal::new(UserId::new(), org, BTreeSet::new(), scope).with_effective_feature_grants(grants)
}

pub const HR: &[Feature] = &[Feature::EmployeeDirectoryRead, Feature::OrgChangeRead];

pub async fn next(connection: &mut RealtimeConnection) -> RealtimeEvent {
    timeout(Duration::from_secs(5), connection.recv())
        .await
        .expect("a frame within 5 s")
        .expect("the slot is open")
}

pub async fn hello(connection: &mut RealtimeConnection) -> i64 {
    match next(connection).await {
        RealtimeEvent::Hello { id, .. } => id.parse().unwrap(),
        other => panic!("expected hello, got {other:?}"),
    }
}

pub fn change(frame: &RealtimeEvent) -> (i64, String, Option<String>) {
    match frame {
        RealtimeEvent::Change { id, data } => (
            id.parse().unwrap(),
            data.resource_type.clone(),
            data.id.clone(),
        ),
        other => panic!("expected change, got {other:?}"),
    }
}
