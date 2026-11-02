// SPDX-License-Identifier: LicenseRef-Proprietary
//! Project command guards using the request's live Cedar grant and placement snapshot.
use std::collections::{BTreeMap, BTreeSet};

use console_platform_authz::{
    Feature, Principal,
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::lifecycle_event::{self, EventFacts},
        visible::{DecisionFacts, load_facts},
    },
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::types::EmployeeLifecycleEventResponse;
use crate::{
    HrError,
    authz::{APPOINTMENT_KEYS, HrCaseFacts},
};

pub(super) enum VoidAction {
    Correct,
    Rescind,
}

impl VoidAction {
    pub(super) fn cedar_action(self) -> &'static str {
        match self {
            Self::Correct => lifecycle_event::CORRECT,
            Self::Rescind => lifecycle_event::RESCIND,
        }
    }
}

pub(super) async fn require_permission(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
) -> Result<bool, HrError> {
    let allowed = load_permission(tx, principal, employee).await?;
    if allowed {
        return Ok(allowed);
    }
    Err(permission_denied())
}

pub(super) fn permission_denied() -> HrError {
    HrError::from_kernel(console_kernel_core::KernelError::forbidden(
        "lifecycle event permission is required in this scope",
    ))
}

pub(super) async fn require_bulk_permission(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
) -> Result<(), HrError> {
    let access = load_facts(tx, principal.org_id, *principal.user_id.as_uuid())
        .await
        .map_err(HrError::from_kernel)?;
    require_tenant_permission_any(&access, principal, &APPOINTMENT_KEYS)
}

impl crate::HrService {
    /// Admit the request before reserving an async driver; acceptance rechecks in its write transaction.
    pub async fn check_bulk_lifecycle_access(&self, principal: &Principal) -> Result<(), HrError> {
        let principal = principal.clone();
        console_platform_db::with_org_conn::<_, _, HrError>(
            &self.pool,
            principal.org_id,
            move |tx| Box::pin(async move { require_bulk_permission(tx, &principal).await }),
        )
        .await
    }
}

/// Tenant-wide preflights use one live Cedar snapshot before reading or validating payloads.
pub(super) async fn require_tenant_permissions(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    features: &[Feature],
) -> Result<(), HrError> {
    let org = principal.org_id;
    let access = load_facts(tx, org, *principal.user_id.as_uuid())
        .await
        .map_err(HrError::from_kernel)?;
    for feature in features {
        require_tenant_permission_any(&access, principal, std::slice::from_ref(feature))?;
    }
    Ok(())
}

fn require_tenant_permission_any(
    access: &DecisionFacts,
    principal: &Principal,
    features: &[Feature],
) -> Result<(), HrError> {
    let org = principal.org_id;
    let mut nodes = BTreeSet::new();
    for feature in features {
        if access
            .authorize(
                feature.as_str(),
                NodeRef {
                    kind: NodeKind::Tenant,
                    id: *org.as_uuid(),
                },
            )
            .map_err(|e| {
                HrError::internal(format!("lifecycle permission facts unavailable: {e}"))
            })?
        {
            return Ok(());
        }
        nodes.extend(access.permitted_nodes(feature.as_str()).map_err(|e| {
            HrError::internal(format!("lifecycle permission facts unavailable: {e}"))
        })?);
    }
    if nodes.is_empty() {
        return Err(permission_denied());
    }
    Err(HrError {
        errors: None,
        status: http::StatusCode::FORBIDDEN,
        code: "scope_tenant_wide_only",
        message: "this works on the whole tenant; a grant over 전체 is needed".to_owned(),
        refusals: Some(Box::new(serde_json::Value::Array(
            nodes
                .into_iter()
                .map(|node| serde_json::json!({"kind": node.kind, "node_id": node.id}))
                .collect(),
        ))),
    })
}

async fn load_permission(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
) -> Result<bool, HrError> {
    let org = principal.org_id;
    let actor = *principal.user_id.as_uuid();
    let access = load_facts(tx, org, actor)
        .await
        .map_err(HrError::from_kernel)?;
    let people = HrCaseFacts::load(tx, actor, &[employee]).await?;
    permission(&access, &people, org, employee)
}

pub(super) fn permission(
    access: &DecisionFacts,
    people: &HrCaseFacts,
    org: console_kernel_core::OrgId,
    employee: Uuid,
) -> Result<bool, HrError> {
    let mut allowed = false;
    for feature in APPOINTMENT_KEYS {
        allowed |= people.permits(access, org, employee, feature)?;
    }
    Ok(allowed)
}

pub(super) async fn project(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    items: &mut [EmployeeLifecycleEventResponse],
) -> Result<(), HrError> {
    let org = principal.org_id;
    let actor = *principal.user_id.as_uuid();
    let holds_permission = load_permission(tx, principal, employee).await?;
    let latest: Option<Uuid> = sqlx::query_scalar(
        "SELECT l.id FROM employee_lifecycle_events l WHERE l.org_id=$1 AND l.employee_id=$2 \
         AND l.state='APPLIED' AND l.event_type<>'RESCIND' \
         AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.voids_event_id=l.id) \
         ORDER BY l.created_at DESC,l.id DESC LIMIT 1",
    )
    .bind(org.as_uuid())
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    for item in items {
        let facts = EventFacts {
            holds_permission,
            state: &item.state,
            kind: &item.event_type,
            voided: item.voided_by.is_some(),
            latest: latest == Some(item.id),
        };
        let mut refusals = BTreeMap::new();
        for (verb, action) in ["correct", "rescind"]
            .into_iter()
            .zip(lifecycle_event::ACTIONS)
        {
            if let Some(code) = lifecycle_event::refusal(
                action,
                &actor.to_string(),
                &org.to_string(),
                &org.to_string(),
                &facts,
            )
            .map_err(HrError::internal)?
            {
                refusals.insert(verb, code);
            }
        }
        item.action_refusals = Some(refusals);
    }
    Ok(())
}
