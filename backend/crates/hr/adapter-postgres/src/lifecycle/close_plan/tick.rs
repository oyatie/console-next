//! The lifecycle tick's 사업장 close step: every due job of every tenant,
//! each in its own transaction. A refused line FAILS the job (nothing of that
//! attempt applies); a fault leaves it for the next tick.

use std::sync::Arc;

use console_entity_adapter_postgres::OrgUnitSetupWritePort;
use console_entity_adapter_postgres::workplace_close_plan::{self as entity, CloseActor};
use console_kernel_core::{AuditEvent, OrgId, UserId};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use time::Date;
use uuid::Uuid;

use super::apply::{Advanced, advance};
use super::rows;
use super::types::entity_error;
use crate::{HrError, HrService};

impl HrService {
    /// The lifecycle tick's call: advance every due job of every tenant, each
    /// in its own transaction. A refused line FAILS the job (nothing of that
    /// attempt applies); a fault leaves it for the next tick. Returns how many
    /// jobs closed their 사업장.
    pub async fn advance_due_workplace_closes(
        &self,
        today: Date,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<usize, String> {
        let pool = &self.pool;
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
        let mut applied = 0;
        for org_uuid in orgs {
            let org = OrgId::from_uuid(org_uuid);
            let due = with_org_conn::<_, _, HrError>(pool, org, move |tx| {
                Box::pin(async move { rows::due(tx, today).await })
            })
            .await;
            for job in due.map_err(|e| e.message)? {
                let port = port.clone();
                let run = with_audits::<_, _, HrError>(pool, org, move |tx| {
                    Box::pin(async move {
                        let Some(head) = rows::head(tx, job, true).await? else {
                            return Ok((None, vec![]));
                        };
                        if !matches!(head.state.as_str(), "SCHEDULED" | "WAITING") {
                            return Ok((None, vec![]));
                        }
                        let mut events = Vec::new();
                        let state = match advance(tx, org, &head, today, port.as_ref(), &mut events)
                            .await?
                        {
                            Advanced::Applied => "APPLIED",
                            Advanced::Waiting(_) => "WAITING",
                        };
                        if state != head.state {
                            rows::set_state(tx, job, state, None).await?;
                            let action = if state == "APPLIED" {
                                "workplace.close_job.apply"
                            } else {
                                "workplace.close_job.wait"
                            };
                            events.push(job_event(tx, org, &head, action).await?);
                        }
                        Ok((Some(state == "APPLIED"), events))
                    })
                })
                .await;
                match run {
                    Ok(Some(true)) => applied += 1,
                    Ok(_) => {}
                    Err(e) if e.status.is_client_error() => fail(pool, org, job, &e).await,
                    Err(e) => {
                        tracing::warn!(%org, %job, error = %e.message, "workplace close job will retry")
                    }
                }
            }
        }
        Ok(applied)
    }
}

/// Record a refused apply as FAILED (its own transaction: the refused one
/// rolled back).
async fn fail(pool: &sqlx::PgPool, org: OrgId, job: Uuid, error: &HrError) {
    let failure =
        json!({ "code": error.code, "message": error.message, "refusals": error.refusals });
    let done = with_audits::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            let Some(head) = rows::head(tx, job, true).await? else {
                return Ok(((), vec![]));
            };
            rows::set_state(tx, job, "FAILED", Some(failure)).await?;
            Ok((
                (),
                vec![job_event(tx, org, &head, "workplace.close_job.fail").await?],
            ))
        })
    })
    .await;
    if let Err(e) = done {
        tracing::warn!(%org, %job, error = %e.message, "workplace close job failure not recorded");
    }
}

async fn job_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    head: &rows::Head,
    action: &str,
) -> Result<AuditEvent, HrError> {
    let who = CloseActor {
        org,
        user: UserId::from_uuid(head.actor_id),
        command: head.command_id,
    };
    entity::job_event(
        tx,
        who,
        action,
        head.workplace_id,
        json!({ "job_id": head.id }),
    )
    .await
    .map_err(entity_error)
}
