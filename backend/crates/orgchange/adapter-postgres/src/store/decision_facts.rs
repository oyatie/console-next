// SPDX-License-Identifier: LicenseRef-Proprietary
//! One admission snapshot for the decision transaction and inbox approval membership.
use crate::*;
use console_platform_authz::{
    access::{NodeKind, NodeRef},
    cedar_pbac::{actions::org_change_step_decide::Facts, visible::load_facts},
};

#[derive(Clone)]
pub enum StepDecisionScope {
    Request(Uuid),
    Requests(Vec<Uuid>),
    OpenQueue,
    Submitted,
}

pub struct StepDecisionFacts {
    pub id: Uuid,
    pub decision: Facts,
    pub requester: bool,
    pub completed: bool,
    pub read: bool,
}

/// A decision names its locked request; submitted documents must have an approval route.
/// The access snapshot is loaded once, and person facts are read in one batch.
///
/// # Errors
/// Database or Cedar fact-loading failures refuse the operation.
pub async fn step_decision_facts_in_tx(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    scope: StepDecisionScope,
) -> Result<Vec<StepDecisionFacts>, PgOrgChangeError> {
    let access = load_facts(tx, org, *actor.as_uuid()).await?;
    // shortcut: tenant-wide approval authority, bind each step when tenant role bindings are stored.
    let node = NodeRef {
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    };
    let holds_permission = access
        .authorize("org_change_approve", node)
        .map_err(|_| KernelError::forbidden("org approval facts unavailable"))?;
    let read = access
        .authorize("org_change_read", node)
        .map_err(|_| KernelError::forbidden("org read facts unavailable"))?;
    let base = Facts {
        holds_permission,
        identities_bound: false,
        actor_is_drafter: false,
        actor_decided_prior_step: false,
        merge_requested: false,
    };
    let (requests, submitted) = match scope {
        StepDecisionScope::Request(id) => (Some(vec![id]), false),
        StepDecisionScope::Requests(ids) => (Some(ids), false),
        StepDecisionScope::OpenQueue => (None, false),
        StepDecisionScope::Submitted => (None, true),
    };
    if !holds_permission && !submitted {
        return Ok(requests
            .unwrap_or_default()
            .into_iter()
            .map(|id| StepDecisionFacts {
                id,
                decision: base,
                requester: false,
                completed: false,
                read,
            })
            .collect());
    }
    let rows: Vec<(Uuid, bool, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT r.id, d.maker_person IS NOT NULL AND d.checker_person IS NOT NULL \
                AND coalesce(p.bound,true), \
                coalesce(d.maker_person=d.checker_person,false), coalesce(p.repeated,false), \
                r.drafted_by=$2, r.status <> 'IN_APPROVAL' \
         FROM org_change_requests r \
         CROSS JOIN LATERAL public.console_decision_people($1,r.drafted_by,$2) d \
         LEFT JOIN LATERAL ( \
           SELECT bool_and(h.maker_person IS NOT NULL AND h.checker_person IS NOT NULL) AS bound, \
                  bool_or(s.decided_by=$2 OR h.maker_person=h.checker_person) AS repeated \
           FROM org_change_approval_steps s \
           CROSS JOIN LATERAL public.console_decision_people($1,s.decided_by,$2) h \
           WHERE s.org_id=$1 AND s.request_id=r.id AND s.decision <> 'PENDING' \
         ) p ON true \
         WHERE r.org_id=$1 AND (r.id=ANY($3::uuid[]) OR ($3 IS NULL AND NOT $4 AND r.status='IN_APPROVAL') \
           OR ($4 AND r.status NOT IN ('DRAFT','PRECHECKED') AND EXISTS \
             (SELECT 1 FROM org_change_approval_steps s WHERE s.org_id=r.org_id AND s.request_id=r.id)))",
    )
    .bind(org.as_uuid())
    .bind(actor.as_uuid())
    .bind(requests)
    .bind(submitted)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|_| {
        KernelError::forbidden("org approval identities unavailable")
            .with_code("org_change.refuse.identity_unbound")
    })?;
    Ok(rows
        .into_iter()
        .map(
            |(id, bound, drafter, prior, requester, completed)| StepDecisionFacts {
                id,
                requester,
                completed,
                read,
                decision: Facts {
                    identities_bound: bound,
                    actor_is_drafter: drafter,
                    actor_decided_prior_step: prior,
                    ..base
                },
            },
        )
        .collect())
}
