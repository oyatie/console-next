//! Ticket evidence follows the staff detail endpoint's current ticket scope.
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::{Action, Feature, Principal, authorize, authorize_capability};
use console_platform_db::DbError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) async fn may_read(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    kind: &str,
    id: Uuid,
) -> Result<bool, DbError> {
    let sql = match kind {
        "support_ticket" => "SELECT branch_id FROM support_tickets WHERE org_id=$1 AND id=$2",
        "support_ticket_acceptance" => {
            "SELECT t.branch_id FROM support_ticket_acceptances a JOIN support_tickets t ON t.org_id=a.org_id AND t.id=a.ticket_id WHERE a.org_id=$1 AND a.id=$2"
        }
        "support_ticket_comment" => {
            "SELECT t.branch_id FROM support_ticket_comments c JOIN support_tickets t ON t.org_id=c.org_id AND t.id=c.ticket_id WHERE c.org_id=$1 AND c.id=$2"
        }
        _ => return Ok(false),
    };
    let Some(branch) = sqlx::query_scalar::<_, Option<Uuid>>(sqlx::AssertSqlSafe(sql))
        .bind(p.org_id.as_uuid())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
    else {
        return Ok(false);
    };
    let action = Action::new(Feature::Login);
    Ok(match branch {
        Some(branch) => authorize(p, action, BranchId::from_uuid(branch)).is_ok(),
        None => {
            matches!(p.branch_scope, BranchScope::All) && authorize_capability(p, action).is_ok()
        }
    })
}

#[cfg(test)]
#[path = "support_tests.rs"]
mod tests;
