//! `PgEmploymentPort`: the synchronous `CanonicalPort` face over the async driver.

use super::error::EmploymentError;
use super::model::{EMPLOYMENT_STATUSES, EmploymentCommand, EmploymentQuery};
use super::projection::{EmploymentEffectiveProjection, EmploymentHead};
use super::write::write_in_tx;
use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::{
    CanonicalPort, CommandId, CommandReceipt, Employment, Preflight,
};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// The one permitted holder of production DML against `employees`,
/// `employment_heads`, `employment_revisions` and
/// `employment_source_bindings`.
#[derive(Debug, Clone)]
pub struct PgEmploymentPort {
    pub(super) pool: PgPool,
    pub(super) runtime: tokio::runtime::Handle,
}

impl PgEmploymentPort {
    #[must_use]
    pub const fn new(pool: PgPool, runtime: tokio::runtime::Handle) -> Self {
        Self { pool, runtime }
    }

    /// Head effective at the database clock. Not-yet-open or already closed
    /// windows and foreign tenant ids are `None` — never a fabricated row.
    pub fn get(
        &self,
        org_id: OrgId,
        employment_id: Uuid,
    ) -> Result<Option<EmploymentHead>, EmploymentError> {
        self.runtime
            .block_on(self.read_heads(*org_id.as_uuid(), Some(employment_id), None))
            .map(|heads| heads.into_iter().next())
    }

    /// Employment state effective at `at`, using revisions known now. The
    /// opening and exit instants are half-open; a later backdated correction
    /// changes this answer without rewriting the legacy current head.
    pub fn get_as_of(
        &self,
        org_id: OrgId,
        employment_id: Uuid,
        at: OffsetDateTime,
    ) -> Result<Option<EmploymentHead>, EmploymentError> {
        self.runtime
            .block_on(self.read_heads(*org_id.as_uuid(), Some(employment_id), Some(at)))
            .map(|heads| heads.into_iter().next())
    }

    /// Heads effective at one database instant in the armed tenant.
    pub fn list(&self, org_id: OrgId) -> Result<Vec<EmploymentHead>, EmploymentError> {
        self.runtime
            .block_on(self.read_heads(*org_id.as_uuid(), None, None))
    }

    /// State effective at `as_of`, using revisions known now. An unknown or
    /// foreign Company source is `None`; an ambiguous reverse binding is refused.
    pub fn read_effective_for_employee(
        &self,
        org_id: OrgId,
        employee_id: Uuid,
        as_of: OffsetDateTime,
    ) -> Result<Option<EmploymentEffectiveProjection>, EmploymentError> {
        self.runtime
            .block_on(self.read_effective(*org_id.as_uuid(), employee_id, Some(as_of)))
    }

    /// Current state with its database instant captured once inside the read
    /// transaction. Async callers must use `spawn_blocking`, as for `get`.
    pub fn read_current_effective_for_employee(
        &self,
        org_id: OrgId,
        employee_id: Uuid,
    ) -> Result<Option<EmploymentEffectiveProjection>, EmploymentError> {
        self.runtime
            .block_on(self.read_effective(*org_id.as_uuid(), employee_id, None))
    }

    pub(super) async fn arm_org<'e, E>(&self, executor: E, org: Uuid) -> Result<(), EmploymentError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(executor)
            .await?;
        Ok(())
    }

    async fn write(&self, command: &EmploymentCommand) -> Result<CommandReceipt, EmploymentError> {
        let mut tx = self.pool.begin().await?;
        // Transaction-local, so it is cleared on COMMIT/ROLLBACK and never
        // leaks to the next checkout of a pooled connection. Unset fails
        // closed: RLS shows no rows and accepts no writes.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(command.org_id.as_uuid().to_string())
            .execute(&mut *tx)
            .await?;
        let receipt = write_in_tx(&mut tx, command).await?;
        tx.commit().await?;
        Ok(receipt)
    }
}

impl CanonicalPort for PgEmploymentPort {
    type Object = Employment;
    type Query = EmploymentQuery;
    type Command = EmploymentCommand;
    type Error = EmploymentError;

    /// PURE: no `&self`, no IO, no persistence. A blocked preflight has written
    /// nothing, so it can never spend an approval.
    fn preflight(query: &Self::Query) -> Preflight {
        let mut blockers = Vec::new();
        let attributes = query.attributes();
        if !attributes.company.is_empty() && attributes.company.trim().is_empty() {
            blockers.push("company must not be blank".to_owned());
        }
        if !EMPLOYMENT_STATUSES.contains(&attributes.employment_status.as_str()) {
            blockers.push(format!(
                "employment_status must be one of {EMPLOYMENT_STATUSES:?}"
            ));
        }
        if attributes.org_unit_id == Some(Uuid::nil()) {
            blockers.push("org_unit_id must not be nil".to_owned());
        }
        if attributes.job_position_id == Some(Uuid::nil()) {
            blockers.push("job_position_id must not be nil".to_owned());
        }
        match query {
            EmploymentQuery::Appoint { employee_id, .. } if employee_id.is_nil() => {
                blockers.push("employee_id must not be nil".to_owned());
            }
            EmploymentQuery::Promote { employment_id, .. }
            | EmploymentQuery::Transfer { employment_id, .. }
                if employment_id.is_nil() =>
            {
                blockers.push("employment_id must not be nil".to_owned());
            }
            _ => {}
        }
        if blockers.is_empty() {
            Preflight::ok()
        } else {
            Preflight::blocked(blockers)
        }
    }

    fn command(
        org_id: OrgId,
        command_id: CommandId,
        actor_id: UserId,
        query: Self::Query,
        action_key: &str,
        object_type_id: Uuid,
    ) -> Self::Command {
        EmploymentCommand {
            org_id,
            command_id,
            actor_id,
            query,
            action_key: action_key.to_owned(),
            object_type_id,
        }
    }

    fn execute(&self, command: &Self::Command) -> Result<CommandReceipt, Self::Error> {
        self.runtime.block_on(self.write(command))
    }
}
