//! The self rule (people-self-33): the facts of the `own_record` Cedar action,
//! computed in the write's transaction, and its typed refusal. Every HR write
//! on one employee calls [`own_record_guard`] once, after its own door and
//! before it writes anything. Cedar decides; nothing here permits.

use console_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, KernelError, OrgId, TraceContext, UserId,
};
use console_platform_authz::access::{load_access_subject, project};
use console_platform_authz::cedar_pbac::actions::own_record::{OwnRecordFacts, decide};
use console_platform_authz::{Feature, PermissionLevel};
use console_platform_db::insert_audit_event;
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;

/// 403 `own_record_forbidden`: the rule and the remedy, for the typed message.
#[must_use]
pub fn own_record_forbidden() -> HrError {
    HrError {
        status: StatusCode::FORBIDDEN,
        code: "own_record_forbidden",
        message: "nobody records an HR act on their own record; another holder in scope, \
                  or the ops account, records it"
            .to_owned(),
        refusals: Some(json!([{ "rule": "own_record", "remedy": "another_holder_or_ops" }])),
    }
}

/// Refuse `actor`'s `feature` write on `employee` when it is the actor's own
/// record. The ops account passes only when no other active account holds
/// `feature` over the employee; that pass writes a review-flagged audit row.
///
/// # Errors
/// 403 `own_record_forbidden`; any query or Cedar failure (fail closed).
pub async fn own_record_guard(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    feature: Feature,
) -> Result<(), HrError> {
    match own_record_decision(tx, org, actor, employee, feature).await? {
        OwnRecord::NotOwn => Ok(()),
        OwnRecord::Refused => Err(own_record_forbidden()),
        OwnRecord::SoleHolderOps => break_glass(tx, org, actor, employee, feature).await,
    }
}

/// Cedar's answer for `actor` on `employee`, without writing anything (the
/// per-record offers of a read use it too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnRecord {
    NotOwn,
    Refused,
    SoleHolderOps,
}

/// # Errors
/// Any query failure; a Cedar error reads as `Refused` (fail closed).
pub async fn own_record_decision(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    feature: Feature,
) -> Result<OwnRecord, HrError> {
    let org_uuid = *org.as_uuid();
    // Self: the linked employee, or another record of the same person
    // (a binding minted for an employee carries `person_id = employee_id`).
    let row = sqlx::query(
        "SELECT COALESCE(u.is_tenant_ops AND u.is_active, false) AS ops, \
           COALESCE(u.employee_id = $3 OR EXISTS ( \
             SELECT 1 FROM employee_person_bindings s \
              LEFT JOIN employee_person_bindings m ON m.org_id = s.org_id AND m.employee_id = u.employee_id \
              WHERE s.org_id = $1 AND s.employee_id = $3 \
                AND (s.person_id = m.person_id OR s.person_id = u.employee_id)), false) AS is_self \
         FROM users u WHERE u.org_id = $1 AND u.id = $2",
    )
    .bind(org_uuid)
    .bind(actor.as_uuid())
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    let (actor_is_ops, subject_is_self) = match row {
        Some(row) => (row.try_get("ops")?, row.try_get("is_self")?),
        None => (false, false),
    };
    if !subject_is_self {
        return Ok(OwnRecord::NotOwn);
    }
    let other_eligible_holders = if actor_is_ops {
        other_holders(tx, org, actor, employee, feature).await?
    } else {
        0
    };
    let facts = OwnRecordFacts {
        subject_is_self,
        actor_is_ops,
        other_eligible_holders,
    };
    Ok(
        if decide(&actor.to_string(), &org_uuid.to_string(), facts) == Ok(true) {
            OwnRecord::SoleHolderOps
        } else {
            OwnRecord::Refused
        },
    )
}

/// The sole-holder break-glass pass (#7): logged, flagged for review.
async fn break_glass(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    feature: Feature,
) -> Result<(), HrError> {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("authz.own_record.break_glass").map_err(HrError::from_kernel)?,
        "employee",
        employee.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "employee_id": employee,
            "feature": feature.as_str(),
            "other_eligible_holders": 0,
            "review_required": true,
        })),
    );
    insert_audit_event(tx, &event)
        .await
        .map_err(|e| HrError::from_kernel(KernelError::internal(e.to_string())))?;
    Ok(())
}

/// Other active, non-ops accounts whose grants reach `feature` over the
/// employee's home 사업장 (a branchless employee needs a tenant-wide grant).
// loads each grant holder's subject (only on the ops-on-self path);
// one SQL over the grant projection when AX-5 puts Cedar at each door.
async fn other_holders(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    feature: Feature,
) -> Result<i64, HrError> {
    let org_uuid = *org.as_uuid();
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE org_id = $1 AND id = $2")
            .bind(org_uuid)
            .bind(employee)
            .fetch_optional(tx.as_mut())
            .await?
            .flatten();
    let accounts: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT g.account_id FROM access_grants g \
           JOIN users u ON u.org_id = g.org_id AND u.id = g.account_id \
          WHERE g.org_id = $1 AND g.status = 'ACTIVE' AND u.is_active AND NOT u.is_tenant_ops \
            AND g.account_id <> $2 AND u.employee_id IS DISTINCT FROM $3",
    )
    .bind(org_uuid)
    .bind(actor.as_uuid())
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    let now = OffsetDateTime::now_utc();
    let mut count = 0;
    for account in accounts {
        let subject = load_access_subject(tx, org, account, now)
            .await
            .map_err(HrError::from_kernel)?;
        let reaches = project(&subject).grants.iter().any(|g| {
            g.feature == feature
                && g.permission == PermissionLevel::Allow
                && branch.map_or(g.branch_scope == BranchScope::All, |b| {
                    g.branch_scope.allows(BranchId::from_uuid(b))
                })
        });
        count += i64::from(reaches);
    }
    Ok(count)
}
