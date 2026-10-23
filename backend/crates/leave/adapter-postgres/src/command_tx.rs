//! Tenant-bound execution of the isolated leave command capability.

use console_kernel_core::{KernelError, UserId};
use console_platform_request_context::current_org;
use sqlx::postgres::{PgArguments, PgRow};
use sqlx::query::Query;
use sqlx::{Postgres, Row};

use crate::{EmployeeHomeBranchUpdate, PgLeaveError, PgLeaveStore};

impl PgLeaveStore {
    pub(super) async fn command_row(
        &self,
        query: Query<'_, Postgres, PgArguments>,
    ) -> Result<PgRow, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let mut tx = self.command_pool()?.begin().await?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.as_uuid().to_string())
            .execute(tx.as_mut())
            .await?;
        console_platform_db::command_outcomes::execution::bind(&mut tx).await?;
        let row = query
            .fetch_one(tx.as_mut())
            .await
            .map_err(map_leave_command_sqlx)?;
        tx.commit().await?;
        Ok(row)
    }

    /// Set the authoritative employee approval-routing branch through the
    /// isolated command capability. The database locks the employee and both
    /// authorization branches, applies optimistic concurrency, and owns audit.
    pub async fn set_employee_home_branch(
        &self,
        employee_id: uuid::Uuid,
        home_branch_id: uuid::Uuid,
        expected_updated_at: time::OffsetDateTime,
        actor: UserId,
        trace: console_kernel_core::TraceContext,
    ) -> Result<EmployeeHomeBranchUpdate, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let row = self
            .command_row(
                sqlx::query(
                    "SELECT * FROM leave_api.set_employee_home_branch(\
             $1,$2,$3,$4,$5,$6,$7)",
                )
                .bind(org.as_uuid())
                .bind(employee_id)
                .bind(home_branch_id)
                .bind(expected_updated_at)
                .bind(actor.as_uuid())
                .bind(trace.trace_id())
                .bind(trace.span_id()),
            )
            .await?;
        Ok(EmployeeHomeBranchUpdate {
            employee_id: row.try_get("employee_id")?,
            home_branch_id: row.try_get("home_branch_id")?,
            updated_at: row.try_get("updated_at")?,
        })
    }

    /// Establish the FIRST home-branch routing authority for an employee just
    /// created by the create flow, through the dedicated create-path command
    /// (`leave_api.set_employee_home_branch_create`). Unlike the general
    /// `set_employee_home_branch`, this is create-scoped: the database verifies
    /// server-side creation evidence (an `employee.create` audit by the actor for
    /// THIS employee with the requested branch) and authorizes with
    /// `assert_employee_directory_manager`, so an org-wide directory manager is
    /// not 403ed after committing the row. The general route function is
    /// unchanged and keeps `assert_org_admin` for arbitrary first assignments.
    pub async fn set_employee_home_branch_create(
        &self,
        employee_id: uuid::Uuid,
        home_branch_id: uuid::Uuid,
        expected_updated_at: time::OffsetDateTime,
        actor: UserId,
        trace: console_kernel_core::TraceContext,
    ) -> Result<EmployeeHomeBranchUpdate, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let row = self
            .command_row(
                sqlx::query(
                    "SELECT * FROM leave_api.set_employee_home_branch_create(\
             $1,$2,$3,$4,$5,$6,$7)",
                )
                .bind(org.as_uuid())
                .bind(employee_id)
                .bind(home_branch_id)
                .bind(expected_updated_at)
                .bind(actor.as_uuid())
                .bind(trace.trace_id())
                .bind(trace.span_id()),
            )
            .await?;
        Ok(EmployeeHomeBranchUpdate {
            employee_id: row.try_get("employee_id")?,
            home_branch_id: row.try_get("home_branch_id")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

pub(super) fn map_leave_command_sqlx(error: sqlx::Error) -> PgLeaveError {
    let message = error
        .as_database_error()
        .map(sqlx::error::DatabaseError::message)
        .unwrap_or_default();
    match message {
        "leave_home_branch.not_workplace" => PgLeaveError::Domain(
            KernelError::validation("the home branch is the 사업장's own branch; move the person with a 전보 to change it")
                .with_code("home_branch_not_workplace"),
        ),
        "leave_create.home_branch_required" => PgLeaveError::MissingHomeBranch,
        "leave_resolve.concurrent_modification"
        | "leave_decide.concurrent_modification"
        | "leave_home_branch.concurrent_modification"
        | "leave_balance_import.concurrent_modification" => PgLeaveError::ConcurrentModification,
        "leave_resolve.not_found"
        | "leave_decide.not_found"
        | "leave_home_branch.employee_not_found"
        | "leave_balance_import.employee_not_found"
        | "employee_import_batch.run_not_found"
        | "leave_home_branch.active_branch_required"
        | "employee_create.active_branch_required" => {
            PgLeaveError::Domain(KernelError::not_found(message.to_owned()))
        }
        "leave_resolve.not_pending"
        | "leave_decide.not_pending"
        | "employee_import_batch.run_not_dry_run"
        | "leave_create.idempotency_conflict"
        | "employee_create.idempotency_conflict"
        | "employee_create.employee_number_conflict"
        | "leave_balance_import.idempotency_conflict"
        | "leave_home_branch.already_assigned" => {
            PgLeaveError::Domain(KernelError::conflict(message.to_owned()))
        }
        "leave.refuse.identity_unbound" => PgLeaveError::Domain(KernelError::forbidden("person binding is unavailable").with_code("leave.refuse.identity_unbound")),
        "leave_write.actor_forbidden"
        | "leave_write.branch_forbidden"
        | "leave_write.org_admin_required"
        | "leave_balance_import.actor_forbidden"
        | "employee_create.actor_forbidden"
        | "employee_create.home_branch_create_required"
        | "leave_create.self_employee_required"
        | "leave_resolve.requester_forbidden"
        | "leave_decide.requester_forbidden"
        | "leave_decide.resolver_forbidden" => {
            PgLeaveError::Domain(KernelError::forbidden(message.to_owned()))
        }
        "leave_decide.insufficient_balance" => PgLeaveError::Domain(KernelError::validation(
            "insufficient exact leave balance for approval",
        )),
        "leave_decide.time_change_ineligible" => PgLeaveError::Domain(KernelError::validation(
            "time_change is ineligible: branch coverage evidence does not meet §60⑤ 요건",
        )),
        "leave_alternate.not_found" => {
            PgLeaveError::Domain(KernelError::not_found("leave request not found"))
        }
        "leave_alternate.not_consult" | "leave_alternate.already_proposed" => {
            PgLeaveError::Domain(KernelError::conflict(message.to_owned()))
        }
        "leave_alternate.requester_only" => PgLeaveError::Domain(KernelError::forbidden(
            "alternate dates may only be proposed by the original requester",
        )),
        message
            if message.starts_with("leave_create.")
                || message.starts_with("employee_create.")
                || message.starts_with("leave_charge.")
                || message.starts_with("leave_resolve.")
                || message.starts_with("leave_decide.")
                || message.starts_with("leave_alternate.")
                || message.starts_with("leave_home_branch.")
                || message.starts_with("leave_balance_import.")
                || message.starts_with("employee_import_batch.")
                || message.starts_with("leave_write.") =>
        {
            PgLeaveError::Domain(KernelError::validation(message.to_owned()))
        }
        _ => PgLeaveError::from(error),
    }
}
