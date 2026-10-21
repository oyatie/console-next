//! Row-level writes shared by the assignment writers (moves, exit ends):
//! a live row is never rewritten (0259); it is superseded and copied.

use console_kernel_core::KernelError;
use sqlx::PgConnection;
use time::Date;
use uuid::Uuid;

use crate::employment_moves::MoveWrite;

fn internal(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("employment assignment write failed: {error}"))
}

pub(crate) async fn supersede(
    conn: &mut PgConnection,
    org: Uuid,
    id: Uuid,
) -> Result<(), KernelError> {
    sqlx::query(
        "UPDATE employment_assignments SET superseded_at = now() WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(id)
    .execute(&mut *conn)
    .await
    .map(drop)
    .map_err(internal)
}

/// Insert a copy of `id` with `valid_to` (`None` = open), written by `w`.
pub(crate) async fn copy_with_end(
    conn: &mut PgConnection,
    w: MoveWrite,
    id: Uuid,
    valid_to: Option<Date>,
) -> Result<(), KernelError> {
    sqlx::query(
        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, \
           valid_from, valid_to, cause, group_transfer_id, actor_id, command_id) \
         SELECT org_id, employee_id, legal_entity_id, workplace_id, valid_from, $3, cause, \
           group_transfer_id, $4, $5 FROM employment_assignments WHERE org_id = $1 AND id = $2",
    )
    .bind(w.org_id)
    .bind(id)
    .bind(valid_to)
    .bind(w.actor_id)
    .bind(w.command_id)
    .execute(&mut *conn)
    .await
    .map(drop)
    .map_err(internal)
}
