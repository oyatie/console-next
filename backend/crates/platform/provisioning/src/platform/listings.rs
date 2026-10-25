//! Transaction-scoped, audited platform listings. Authority belongs to the caller.
use crate::{
    GroupSummary, OrganizationSummary, PlatformProvisioner, ProvisioningError, RouteAdoptionMetric,
    TenantHealth, group_from_row,
};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Row, Transaction};
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    pub async fn list_groups_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<GroupSummary>, ProvisioningError> {
        let rows = sqlx::query(
            r#"
            SELECT id, slug, name, status, created_at, updated_at, member_count, members
            FROM platform_list_groups()
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let groups = rows
            .into_iter()
            .map(group_from_row)
            .collect::<Result<Vec<_>, ProvisioningError>>()?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.list")?,
            "groups",
            "list",
            TraceContext::generate(),
            now,
        )
        .with_snapshots(None, Some(serde_json::json!({ "count": groups.len() })));
        insert_audit_event(tx, &event).await?;

        Ok(groups)
    }

    pub async fn list_tenants_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<OrganizationSummary>, ProvisioningError> {
        let rows = sqlx::query(
            r#"
            SELECT
                id, slug, name, status, created_at, updated_at,
                group_id, group_slug, group_name, platform_organization_domain_aliases(id) AS domain_aliases, platform_organization_pending_domain(id) AS pending_domain, facts.*
            FROM platform_list_organizations() CROSS JOIN LATERAL platform_tenant_facts(id) facts
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let summaries = rows
            .into_iter()
            .map(|row| {
                Ok(OrganizationSummary {
                    id: row.try_get("id")?,
                    slug: row.try_get("slug")?,
                    domain_aliases: row.try_get("domain_aliases")?,
                    pending_domain: row.try_get("pending_domain")?,
                    removable: row.try_get("removable")?,
                    removal_refusal: row.try_get("removal_refusal")?,
                    lifecycle: row.try_get("lifecycle")?,
                    code_issued_count: row.try_get("code_issued_count")?,
                    passkey_registered_count: row.try_get("passkey_registered_count")?,
                    name: row.try_get("name")?,
                    status: row.try_get("status")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    group_id: row.try_get("group_id")?,
                    group_slug: row.try_get("group_slug")?,
                    group_name: row.try_get("group_name")?,
                })
            })
            .collect::<Result<Vec<_>, ProvisioningError>>()?;

        // Audited cross-tenant read. This is a PLATFORM-tier event (no single
        // target tenant), so it carries org_id = NULL — the audit_events WITH
        // CHECK allows a NULL-org platform row even with no tenant GUC armed.
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.list")?,
            "organizations",
            "list",
            TraceContext::generate(),
            now,
        )
        .with_snapshots(None, Some(serde_json::json!({ "count": summaries.len() })));
        insert_audit_event(tx, &event).await?;

        Ok(summaries)
    }

    pub async fn list_tenant_health_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<TenantHealth>, ProvisioningError> {
        let rows = sqlx::query(
            r#"
            SELECT
                id, slug, name, status, group_id, group_slug, group_name,
                user_count, facts.passkey_registered_count AS active_user_count,
                active_work_orders, open_work_orders, last_activity_at
            FROM platform_org_health() CROSS JOIN LATERAL platform_tenant_facts(id) facts
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let adoption_rows = sqlx::query(
            r#"
            SELECT
                org_id, release_cycle, console_route_events, legacy_route_events,
                rum_error_events, rum_perf_p95_ms, last_event_at
            FROM platform_console_route_adoption()
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let mut adoption_by_org: BTreeMap<Uuid, Vec<RouteAdoptionMetric>> = BTreeMap::new();
        for row in adoption_rows {
            adoption_by_org
                .entry(row.try_get("org_id")?)
                .or_default()
                .push(RouteAdoptionMetric {
                    release_cycle: row.try_get("release_cycle")?,
                    console_route_events: row.try_get("console_route_events")?,
                    legacy_route_events: row.try_get("legacy_route_events")?,
                    rum_error_events: row.try_get("rum_error_events")?,
                    rum_perf_p95_ms: row.try_get("rum_perf_p95_ms")?,
                    last_event_at: row.try_get("last_event_at")?,
                });
        }

        let mut health = Vec::with_capacity(rows.len());
        for row in rows {
            let id: Uuid = row.try_get("id")?;
            let route_adoption = adoption_by_org.remove(&id).unwrap_or_default();
            let zero_legacy_release_cycles = route_adoption
                .iter()
                .filter(|metric| metric.console_route_events > 0 && metric.legacy_route_events == 0)
                .count() as i64;
            health.push(TenantHealth {
                id,
                slug: row.try_get("slug")?,
                name: row.try_get("name")?,
                status: row.try_get("status")?,
                group_id: row.try_get("group_id")?,
                group_slug: row.try_get("group_slug")?,
                group_name: row.try_get("group_name")?,
                user_count: row.try_get("user_count")?,
                active_user_count: row.try_get("active_user_count")?,
                active_work_orders: row.try_get("active_work_orders")?,
                open_work_orders: row.try_get("open_work_orders")?,
                last_activity_at: row.try_get("last_activity_at")?,
                route_adoption,
                zero_legacy_release_cycles,
            });
        }

        // Audited cross-tenant read (PLATFORM-tier; org_id = NULL).
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.health")?,
            "organizations",
            "health",
            TraceContext::generate(),
            now,
        )
        .with_snapshots(None, Some(serde_json::json!({ "count": health.len() })));
        insert_audit_event(tx, &event).await?;

        Ok(health)
    }
}
