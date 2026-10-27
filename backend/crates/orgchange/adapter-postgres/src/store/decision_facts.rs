// SPDX-License-Identifier: LicenseRef-Proprietary
//! One admission snapshot for the decision transaction and inbox approval membership.
use crate::*;
use console_platform_authz::{
    access::{NodeKind, NodeRef},
    cedar_pbac::{actions::org_change_step_decide::Facts, visible::load_facts},
};

/// `request = None` loads the open approval queue; a decision names its locked request.
/// The access snapshot is loaded once, and person facts are read in one batch.
///
/// # Errors
/// Database or Cedar fact-loading failures refuse the operation.
pub async fn step_decision_facts_in_tx(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    request: Option<Uuid>,
) -> Result<Vec<(Uuid, Facts)>, PgOrgChangeError> {
    let access = load_facts(tx, org, *actor.as_uuid()).await?;
    // shortcut: tenant-wide approval authority, bind each step when tenant role bindings are stored.
    let holds_permission = access
        .authorize(
            "org_change_approve",
            NodeRef {
                kind: NodeKind::Tenant,
                id: *org.as_uuid(),
            },
        )
        .map_err(|_| KernelError::forbidden("org approval facts unavailable"))?;
    let base = Facts {
        holds_permission,
        identities_bound: false,
        actor_is_drafter: false,
        actor_decided_prior_step: false,
        merge_requested: false,
    };
    if !holds_permission {
        return Ok(request.into_iter().map(|id| (id, base)).collect());
    }
    let rows: Vec<(Uuid, bool, bool, bool)> = sqlx::query_as(
        "SELECT r.id, d.maker_person IS NOT NULL AND d.checker_person IS NOT NULL \
                AND coalesce(p.bound,true), \
                coalesce(d.maker_person=d.checker_person,false), coalesce(p.repeated,false) \
         FROM org_change_requests r \
         CROSS JOIN LATERAL public.console_decision_people($1,r.drafted_by,$2) d \
         LEFT JOIN LATERAL ( \
           SELECT bool_and(h.maker_person IS NOT NULL AND h.checker_person IS NOT NULL) AS bound, \
                  bool_or(s.decided_by=$2 OR h.maker_person=h.checker_person) AS repeated \
           FROM org_change_approval_steps s \
           CROSS JOIN LATERAL public.console_decision_people($1,s.decided_by,$2) h \
           WHERE s.org_id=$1 AND s.request_id=r.id AND s.decision <> 'PENDING' \
         ) p ON true \
         WHERE r.org_id=$1 AND (r.id=$3 OR ($3 IS NULL AND r.status='IN_APPROVAL'))",
    )
    .bind(org.as_uuid())
    .bind(actor.as_uuid())
    .bind(request)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|_| {
        KernelError::forbidden("org approval identities unavailable")
            .with_code("org_change.refuse.identity_unbound")
    })?;
    Ok(rows
        .into_iter()
        .map(|(id, bound, drafter, prior)| {
            (
                id,
                Facts {
                    identities_bound: bound,
                    actor_is_drafter: drafter,
                    actor_decided_prior_step: prior,
                    ..base
                },
            )
        })
        .collect())
}
