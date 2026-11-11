// SPDX-License-Identifier: LicenseRef-Proprietary
//! The inbox needs readiness details only when the viewer has setup actions.
use super::*;
use console_kernel_core::KernelError;
use console_platform_authz::{
    access::{AccessSlice, AccessSubject},
    cedar_pbac::visible::DecisionFacts,
};
use std::{future::Future, pin::Pin, sync::Arc};

impl PgOnboardingStore {
    /// Read setup details only when the current viewer can act on the setup rail.
    ///
    /// # Errors
    /// Database faults or a refused checklist read.
    pub async fn actionable_checklist<F>(
        &self,
        actor: &OnboardingActor,
        authorization: F,
    ) -> Result<Option<Checklist>, PgOnboardingError>
    where
        F: for<'a> FnOnce(
                &'a mut Transaction<'_, Postgres>,
            ) -> Pin<
                Box<dyn Future<Output = Result<Arc<DecisionFacts>, KernelError>> + Send + 'a>,
            > + Send
            + 'static,
    {
        let viewer = actor.clone();
        let result = with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let phase = phase(tx, false).await?;
                if phase != TenantPhase::Setup {
                    return Ok(None);
                }
                let access = authorization(tx).await?;
                let (subject, slice) =
                    access.access_permissions(viewer.org, *viewer.user.as_uuid())?;
                let mut candidate =
                    checklist(&facts::permission_facts(tx, viewer.org, true).await?);
                viewer::apply_permissions(subject, slice, &mut candidate)?;
                if !candidate.steps.iter().any(|step| step.can_act) {
                    return Ok(None);
                }
                read_checklist(tx, &viewer, phase, subject, slice)
                    .await
                    .map(Some)
            })
        })
        .await;
        self.audit_refusal(actor, result).await
    }
}

pub(crate) async fn read_checklist(
    tx: &mut Transaction<'_, Postgres>,
    actor: &OnboardingActor,
    phase: TenantPhase,
    subject: &AccessSubject,
    slice: &AccessSlice,
) -> Result<Checklist, PgOnboardingError> {
    let (facts, _, _) = facts::setup_facts(
        tx,
        (actor.org, *actor.user.as_uuid()),
        phase == TenantPhase::Setup,
    )
    .await?;
    let mut result = checklist(&facts);
    viewer::apply_permissions(subject, slice, &mut result)?;
    let at: Option<time::OffsetDateTime> =
        sqlx::query_scalar("SELECT go_live_at FROM tenant_phase WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
            .flatten();
    result.go_live_at = at
        .map(|at| at.format(&time::format_description::well_known::Rfc3339))
        .transpose()
        .map_err(|_| refused(ErrorKind::Internal, "internal", None))?;
    Ok(result)
}
