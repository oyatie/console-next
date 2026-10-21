//! First home-branch assignment after create (moved from `app/src/hr.rs`,
//! R2-people).

use console_kernel_core::{KernelError, OrgId, TraceContext, UserId};
use console_leave_adapter_postgres::{PgLeaveError, PgLeaveStore};
use console_platform_authz::Principal;
use console_platform_db::with_org_conn;
use http::StatusCode;
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_home_branch_transition;
use crate::directory::create_placement::{branch_refused, workplace_branch};
use crate::directory::read_detail::load_employee_detail;
use crate::directory::types::{
    EmployeeDetailResponse, EmployeeHomeBranchResponse, SetEmployeeHomeBranchRequest,
};
use crate::{HrError, HrService};

/// Establish the employee's first home-branch routing authority through the
/// isolated leave command capability (`leave_api.set_employee_home_branch`,
/// which CASes on `updated_at`, re-validates the branch, requires the
/// org-wide admin capability for a first assignment, and writes its own
/// `employee.home_branch_set` audit). Idempotent and race-convergent: an
/// already-assigned employee (replay) is returned untouched, and losing a
/// concurrent first-assignment race to the SAME branch is success. A FRESH
/// creation that finds a DIFFERENT branch already assigned lost the routing
/// race to another org-wide directory manager and is refused (conflict) rather
/// than reported as 201 for the wrong branch.
pub async fn assign_home_branch_if_unset(
    pool: &PgPool,
    command_store: &PgLeaveStore,
    org: OrgId,
    employee_id: Uuid,
    home_branch_id: Uuid,
    actor: UserId,
    replayed: bool,
) -> Result<EmployeeDetailResponse, HrError> {
    let load = |pool: &PgPool| {
        let pool = pool.clone();
        async move {
            with_org_conn::<_, _, HrError>(&pool, org, move |tx| {
                Box::pin(async move { load_employee_detail(tx, *org.as_uuid(), employee_id).await })
            })
            .await
        }
    };
    let detail = load(pool).await?;
    if let Some(existing_branch) = detail.employee_home_branch_id() {
        // A replayed create already established routing authority and a replay
        // must never clobber a later reassignment. A FRESH creation that finds a
        // DIFFERENT branch means another org-wide directory manager won the
        // first-assignment race — refuse rather than return success for an
        // employee routed to the wrong branch.
        if replayed || existing_branch == home_branch_id {
            return Ok(detail);
        }
        return Err(HrError::from_kernel(KernelError::conflict(
            "employee's home branch was assigned to a different branch concurrently",
        )));
    }
    match command_store
        .set_employee_home_branch_create(
            employee_id,
            home_branch_id,
            detail.employee_updated_at(),
            actor,
            TraceContext::generate(),
        )
        .await
    {
        Ok(_) => load(pool).await,
        Err(PgLeaveError::ConcurrentModification) => {
            let current = load(pool).await?;
            if current.employee_home_branch_id() == Some(home_branch_id) {
                // A same-key race partner won the identical first assignment.
                Ok(current)
            } else {
                Err(HrError::from_leave_store(
                    PgLeaveError::ConcurrentModification,
                ))
            }
        }
        Err(error) => {
            let mapped = HrError::from_leave_store(error);
            // Telemetry canary (LOW-4, shared across BOTH employee-creating
            // surfaces): after HIGH-1 the routing authority is the SAME
            // `assert_employee_directory_manager` predicate that passed
            // in-transaction BEFORE any write, so a FORBIDDEN (403) here means
            // either (a) predicate drift, or (b) a genuine mid-window
            // revocation/deactivation that committed after `with_audits`
            // released its `FOR UPDATE` locks. BOTH orphan the just-committed
            // row, so a non-zero count is an INVESTIGATE signal, never a false
            // alarm. Concurrent-modification / branch-deactivated /
            // command-unavailable failures are NOT forbidden and are NOT counted.
            if mapped.status == StatusCode::FORBIDDEN {
                metrics::counter!("hr_employee_create_write_then_deny_total").increment(1);
            }
            Err(mapped)
        }
    }
}

/// The branch of the 사업장 the employee is placed at today (KST), if any.
async fn placed_branch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<Uuid>, HrError> {
    let workplace: Option<Uuid> = sqlx::query_scalar(
        "SELECT workplace_id FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND workplace_id IS NOT NULL \
         AND valid_from <= (now() AT TIME ZONE 'Asia/Seoul')::date \
         AND (valid_to IS NULL OR valid_to > (now() AT TIME ZONE 'Asia/Seoul')::date)",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    match workplace {
        Some(workplace) => workplace_branch(tx.as_mut(), org, workplace).await,
        None => Ok(None),
    }
}

impl HrService {
    /// Assign the employee's authoritative approval-routing branch. No inference is
    /// accepted: the caller names one active branch and must have manage authority
    /// over both that branch and the employee's prior home branch (when present).
    /// The row mutation and its before/after audit snapshots commit atomically.
    pub async fn set_home_branch(
        &self,
        principal: Principal,
        command_store: PgLeaveStore,
        employee_id: Uuid,
        body: SetEmployeeHomeBranchRequest,
    ) -> Result<EmployeeHomeBranchResponse, HrError> {
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        let target_branch_id = body.branch_id;
        let expected_updated_at = OffsetDateTime::parse(
            body.expected_updated_at.trim(),
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| HrError::validation("expected_updated_at must be an RFC 3339 timestamp"))?;
        let trace = TraceContext::generate();

        let (branch_name, prior_branch_id, prior_updated_at) =
            with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let branch = sqlx::query(
                        "SELECT id, name FROM branches \
                 WHERE org_id = $1 AND id = $2 AND deactivated_at IS NULL",
                    )
                    .bind(org_uuid)
                    .bind(target_branch_id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| {
                        HrError::from_kernel(KernelError::not_found(
                            "active home branch was not found in this organization",
                        ))
                    })?;
                    let branch_name: String = branch.try_get("name")?;

                    let employee = sqlx::query(
                "SELECT home_branch_id, updated_at FROM employees WHERE org_id = $1 AND id = $2",
            )
            .bind(org_uuid)
            .bind(employee_id)
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| {
                HrError::from_kernel(KernelError::not_found(
                    "employee was not found in this organization",
                ))
            })?;
                    let prior_branch_id: Option<Uuid> = employee.try_get("home_branch_id")?;
                    let prior_updated_at: OffsetDateTime = employee.try_get("updated_at")?;
                    // UX-R1 PLACEMENT (org-19): a placed person's branch is their 사업장's;
                    // changing where they work is a dated 전보, never this one click.
                    if placed_branch(tx, org_uuid, employee_id)
                        .await?
                        .is_some_and(|branch| branch != target_branch_id)
                    {
                        return Err(branch_refused());
                    }

                    Ok((branch_name, prior_branch_id, prior_updated_at))
                })
            })
            .await?;

        authorize_home_branch_transition(&principal, prior_branch_id, target_branch_id)?;
        if prior_updated_at != expected_updated_at {
            return Err(HrError::from_kernel(KernelError::conflict(
                "employee changed since it was read; reload before assigning a home branch",
            )));
        }

        // Sensitive employee routing columns are mechanically protected from
        // direct `console_rt` UPDATE. The adapter routes this mutation through the
        // separately credentialed command pool; the database re-checks tenant,
        // actor, branch authority, active-branch state, and optimistic version and
        // owns the one atomic before/after audit.
        let updated = console_platform_request_context::scope_org(org, async move {
            command_store
                .set_employee_home_branch(
                    employee_id,
                    target_branch_id,
                    expected_updated_at,
                    actor,
                    trace,
                )
                .await
        })
        .await
        .map_err(HrError::from_leave_store)?;

        let response = EmployeeHomeBranchResponse {
            employee_id: updated.employee_id,
            branch_id: updated.home_branch_id,
            branch_name,
            updated_at: updated.updated_at,
        };

        Ok(response)
    }
}
