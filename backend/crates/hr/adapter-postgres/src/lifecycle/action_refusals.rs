// SPDX-License-Identifier: LicenseRef-Proprietary
//! Project command guards using the request's live Cedar grant and placement snapshot.
use std::collections::BTreeMap;

use console_platform_authz::{
    Principal,
    cedar_pbac::{
        actions::lifecycle_event::{self, EventFacts},
        visible::load_facts,
    },
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::types::EmployeeLifecycleEventResponse;
use crate::{
    HrError,
    authz::{APPOINTMENT_KEYS, HrCaseFacts},
};

pub(super) async fn require_permission(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
) -> Result<bool, HrError> {
    let allowed = permission(tx, principal, employee).await?;
    if allowed {
        return Ok(allowed);
    }
    Err(HrError::from_kernel(
        console_kernel_core::KernelError::forbidden(
            "lifecycle event permission is required in this scope",
        ),
    ))
}

async fn permission(
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
    let mut allowed = false;
    for feature in APPOINTMENT_KEYS {
        allowed |= people.permits(&access, org, employee, feature)?;
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
    let holds_permission = permission(tx, principal, employee).await?;
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
