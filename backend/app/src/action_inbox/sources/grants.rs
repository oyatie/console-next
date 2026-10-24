// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pending grant notices use the account's own effective-access read.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_access::{AccessService, effective};
use console_platform_authz::Principal;
use std::collections::BTreeSet;
use time::OffsetDateTime;

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let org = principal.org_id;
    let user = principal.user_id;
    // Most accounts have no notices; do not expand every effective permission for an empty source.
    let has_work = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| Box::pin(async move {
        Ok(sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM access_grants WHERE org_id=$1 AND account_id=$2 AND status='ACTIVE' AND (valid_to IS NULL OR valid_to>now())) OR \
            ((SELECT count(*) FROM auth_webauthn_credentials WHERE org_id=$1 AND user_id=$2)=1 AND NOT EXISTS (SELECT 1 FROM tenant_phase WHERE org_id=$1 AND phase='SETUP'))")
            .bind(org.as_uuid()).bind(user.as_uuid()).fetch_one(tx.as_mut()).await?)
    })).await.map_err(|e| {
        tracing::error!(error = ?e, "account inbox availability failed");
        KernelError::internal("failed to load account work")
    })?;
    if !has_work {
        return Ok(super::super::empty_source_page());
    }
    let mut access = effective::me(&AccessService::new(pool.clone(), None), principal.clone())
        .await
        .map_err(|e| {
            tracing::error!(error = ?e, "grant inbox source failed");
            KernelError::internal("failed to load grant notices")
        })?;
    let scopes: Vec<_> = access["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["scope"]["kind"] != "TENANT")
        .map(|entry| entry["scope"].clone())
        .collect();
    let (grant_times, security, scope_names) = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| Box::pin(async move {
        let times: Vec<(uuid::Uuid, OffsetDateTime)> = sqlx::query_as("SELECT id, granted_at FROM access_grants WHERE org_id = $1 AND account_id = $2 AND status = 'ACTIVE' AND (valid_to IS NULL OR valid_to > now())")
            .bind(org.as_uuid()).bind(user.as_uuid()).fetch_all(tx.as_mut()).await?;
        let security: Option<(OffsetDateTime, String)> = sqlx::query_as("SELECT created_at, display_name FROM person_accounts_current WHERE org_id = $1 AND id = $2 AND (SELECT count(*) FROM auth_webauthn_credentials WHERE org_id = $1 AND user_id = $2) = 1 AND NOT EXISTS (SELECT 1 FROM tenant_phase WHERE org_id = $1 AND phase = 'SETUP')")
            .bind(org.as_uuid()).bind(user.as_uuid()).fetch_optional(tx.as_mut()).await?;
        // The holder may learn the names of their own grant scopes without an org-tree grant.
        let names: Vec<(String, uuid::Uuid, Option<String>)> = if scopes.is_empty() { Vec::new() } else {
            sqlx::query_as("SELECT DISTINCT s.kind, s.node_id, CASE s.kind \
                WHEN 'LEGAL_ENTITY' THEN (SELECT r.name FROM legal_entity_revisions r WHERE r.org_id=$1 AND r.legal_entity_id=s.node_id AND r.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) \
                WHEN 'WORKPLACE' THEN (SELECT r.name FROM workplace_revisions r WHERE r.org_id=$1 AND r.workplace_id=s.node_id AND r.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) \
                WHEN 'DEPARTMENT' THEN (SELECT r.attributes->>'name' FROM org_unit_revisions r WHERE r.org_id=$1 AND r.org_unit_id=s.node_id AND COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date) <= (now() AT TIME ZONE 'Asia/Seoul')::date ORDER BY COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date) DESC, r.version DESC LIMIT 1) \
                END FROM jsonb_to_recordset($2) AS s(kind text, node_id uuid) WHERE s.node_id IS NOT NULL")
                .bind(org.as_uuid()).bind(serde_json::Value::Array(scopes)).fetch_all(tx.as_mut()).await?
        };
        Ok((times, security, names))
    })).await.map_err(|e| { tracing::error!(error = ?e, "account inbox source failed"); KernelError::internal("failed to load account work") })?;
    for entry in access["entries"].as_array_mut().into_iter().flatten() {
        let scope = &mut entry["scope"];
        let node = scope["node_id"]
            .as_str()
            .and_then(|id| id.parse::<uuid::Uuid>().ok());
        if let Some((_, _, Some(name))) = scope_names.iter().find(|(kind, id, _)| {
            scope["kind"].as_str() == Some(kind.as_str()) && node == Some(*id)
        }) {
            scope["node_name"] = serde_json::Value::String(name.clone());
        }
    }
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    for entry in access["entries"].as_array().into_iter().flatten() {
        let Some(id) = entry["grant_id"].as_str() else {
            continue;
        };
        if !entry["noticed_at"].is_null() || !seen.insert(id) {
            continue;
        }
        if access["is_ops"] == true {
            continue;
        }
        let Some(created_at) = grant_times
            .iter()
            .find(|(grant, _)| grant.to_string() == id)
            .map(|(_, at)| *at)
        else {
            continue;
        };
        if created_at > query.as_of {
            continue;
        }
        items.push(ActionInboxSourceItem {
            context: Some(serde_json::json!({"grants": access["entries"].as_array().into_iter().flatten().filter(|line| line["grant_id"] == id).collect::<Vec<_>>() })),
            id: format!("grant_notice:{id}"),
            kind: "grant_notice".into(),
            ref_code: String::new(),
            title: entry["role_name_ko"].as_str().unwrap_or_default().into(),
            site: None,
            who: None,
            due: None,
            submitted: None,
            created_at,
            links: vec![ActionInboxLink {
                kind: "access".into(),
                id: id.into(),
                label: None,
            }],
        });
    }
    if let Some((created_at, display_name)) = security.filter(|(at, _)| *at <= query.as_of) {
        items.push(ActionInboxSourceItem {
            context: Some(serde_json::json!({"is_ops": access["is_ops"]})),
            id: format!("account_security:{}", principal.user_id),
            kind: "account_security".into(),
            ref_code: String::new(),
            title: display_name,
            site: None,
            who: None,
            due: None,
            submitted: None,
            created_at,
            links: vec![ActionInboxLink {
                kind: "account".into(),
                id: principal.user_id.to_string(),
                label: None,
            }],
        });
    }
    let total = items.len();
    items.retain(|i| {
        query
            .after
            .as_ref()
            .is_none_or(|p| (i.created_at, &i.id) > (p.created_at, &p.id))
    });
    items.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{BranchScope, OrgId};
    use console_platform_authz::{Action, Feature, authorize_capability};
    use console_platform_test_support::{
        runtime_role_pool, seed_active_user, seed_org_and_super_admin,
    };
    use serde_json::json;
    use uuid::Uuid;

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn no_account_work_does_not_expand_the_effective_access_catalog(pool: sqlx::PgPool) {
        let org = OrgId::new();
        let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "empty-account-work").await;
        sqlx::query("REVOKE SELECT ON access_roles FROM console_rt")
            .execute(&pool)
            .await
            .unwrap();
        let runtime = runtime_role_pool(&pool).await;
        let principal = Principal::new(user, org, BTreeSet::new(), BranchScope::All);
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let page = page(
            &runtime,
            &principal,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now,
                as_of: now,
                after: None,
                limit: 20,
            },
        )
        .await
        .expect("an empty account source needs no effective-access expansion");
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
        assert!(page.total_is_exact);
    }

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn a_scheduled_scoped_hr_grant_discloses_its_name_without_org_read_before_confirmation(
        pool: sqlx::PgPool,
    ) {
        let org = OrgId::new();
        let admin = seed_org_and_super_admin(&pool, *org.as_uuid(), "notice-scope").await;
        let holder = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "notice-holder").await;
        let unit = Uuid::new_v4();
        sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
            .bind(org.as_uuid())
            .bind(unit)
            .execute(&pool)
            .await
            .unwrap();
        for (version, name, days) in [(1_i64, "급여 담당 부서", 0), (2, "다음 부서명", 30)]
        {
            sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,$3,gen_random_uuid(),$4,decode(repeat('ab',32),'hex'),jsonb_build_object('kind','department','name',$5::text,'effective_from',((now() AT TIME ZONE 'Asia/Seoul')::date+$6)::text),'{}')")
                .bind(org.as_uuid()).bind(unit).bind(version).bind(admin.as_uuid()).bind(name).bind(days)
                .execute(&pool).await.unwrap();
        }
        let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles (org_id,name_ko,status,version,created_by) VALUES ($1,'급여 담당','ACTIVE',1,$2) RETURNING id")
            .bind(org.as_uuid()).bind(admin.as_uuid()).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'급여 담당','ACTIVE','SETUP',$3)")
            .bind(org.as_uuid()).bind(role).bind(admin.as_uuid()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view','edit'])")
            .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
        let grant: Uuid = sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,org_unit_id,valid_from,valid_to,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'DEPARTMENT',$4,now()+interval '2 days',now()+interval '20 days','SETUP','NEW_HIRE',$5) RETURNING id")
            .bind(org.as_uuid()).bind(holder.as_uuid()).bind(role).bind(unit).bind(admin.as_uuid()).fetch_one(&pool).await.unwrap();
        let principal = Principal::new(holder, org, BTreeSet::new(), BranchScope::All);
        assert!(authorize_capability(&principal, Action::new(Feature::OrgChangeRead)).is_err());
        let runtime = runtime_role_pool(&pool).await;
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let query = ActionInboxSourceQuery {
            filter: Default::default(),
            require_exact_total: false,
            now,
            as_of: now,
            after: None,
            limit: 20,
        };
        let page = page(&runtime, &principal, query.clone()).await.unwrap();
        assert_eq!(page.items.len(), 1);
        let context = page.items[0].context.as_ref().unwrap();
        let lines = context["grants"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        for line in lines {
            assert_eq!(
                line["scope"],
                json!({"kind":"DEPARTMENT","node_id":unit,"include_descendants":true,"node_name":"급여 담당 부서"})
            );
            assert_eq!(line["domain"], "hr_basic");
            assert_eq!(line["enforcement"], "SCHEDULED");
            assert!(line["valid_from"].is_string() && line["valid_to"].is_string());
        }
        console_platform_access::notice::confirm(
            &AccessService::new(runtime.clone(), None),
            principal.clone(),
            grant,
        )
        .await
        .unwrap();
        assert!(
            super::page(&runtime, &principal, query)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }
}
