// SPDX-License-Identifier: LicenseRef-Proprietary
//! Transaction-bound solo binding eligibility using the canonical Cedar facts.
use crate::second_person::{HolderCapability, PgHolderResolver};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::{actions::account_link_solo, visible::load_facts};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

/// Eligibility for an offer, never permission to change the binding. The command
/// must reload inside its write transaction and enforce step-up and review.
/// No grant age or notice requirement: even a new, unbound holder rules out solo binding.
///
/// # Errors
/// Missing tenant RLS, an inactive actor, or unavailable database/Cedar facts.
pub async fn eligibility_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    target: UserId,
) -> Result<bool, KernelError> {
    let facts = facts_in_tx(tx, org, actor, target).await?;
    decide(org, actor, facts)
}

pub(crate) fn decide(
    org: OrgId,
    actor: UserId,
    facts: account_link_solo::Facts,
) -> Result<bool, KernelError> {
    account_link_solo::decide(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        facts,
    )
    .map_err(KernelError::internal)
}

pub(crate) async fn facts_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    target: UserId,
) -> Result<account_link_solo::Facts, KernelError> {
    let account = load_facts(tx, org, *actor.as_uuid()).await?;
    let (subject, _) = account.access_permissions(org, *actor.as_uuid())?;
    let holds_permission = account
        .authorize(
            Feature::UserManage.as_str(),
            NodeRef {
                kind: NodeKind::Tenant,
                id: *org.as_uuid(),
            },
        )
        .map_err(|error| KernelError::internal(error.to_string()))?;
    let mut facts = account_link_solo::Facts {
        subject_is_self: actor == target,
        operator: subject.is_ops,
        unbound: account.linked_employee_id().is_none(),
        holds_permission,
        other_holder: false,
    };
    if !decide(org, actor, facts)? {
        return Ok(facts);
    }
    // The set-based resolver uses one query, including every active operations account.
    facts.other_holder = !PgHolderResolver {
        tx,
        org,
        capability: HolderCapability::AccessAdmin,
        exclude_account: Some(*actor.as_uuid()),
        exclude_employee: None,
        include_ops: true,
        now: OffsetDateTime::now_utc(),
    }
    .resolve_at_most(1)
    .await?
    .is_empty();
    Ok(facts)
}
