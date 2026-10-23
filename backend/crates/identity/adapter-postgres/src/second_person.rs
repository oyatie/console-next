//! BW-29: the eligible-second-person fact (decisions D0.2). Owned by identity,
//! because it is computed from role assignments; a lane's use case calls
//! [`second_person_fact_in_tx`] inside its decision transaction, after locking
//! the subject row (D0.1 §4), and puts `other_eligible_holders` into the Cedar
//! context as a Long.
//!
//! SQL (`second_person_candidates`, migrations 0254 and 0361) returns every
//! row the definition looks at, with a reason: legacy system roles, custom
//! policy roles and the 권한 screen's access grants (role × scope × dates).
//! Rust finalises each custom-role and access-grant row's scope (the access
//! grant alone, through Cedar) and counts. Settings values arrive resolved
//! (plan D2).

use std::collections::BTreeSet;

use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Role};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// The "7 days before" case creation of the demotion guard (decisions.md D0.2).
/// Not a tenant setting: the decision fixes it.
pub const DEMOTION_LOOKBACK_DAYS: i32 = 7;

/// Roles that resolve to [`BranchScope::All`]; mirrors
/// `console_platform_authz::resolve_branch_scope_in_tx`.
// copied list of two; take it from authz once it exports one.
const ALL_SCOPE_ROLES: [Role; 2] = [Role::SuperAdmin, Role::Executive];

/// One act that needs a second person.
#[derive(Debug, Clone)]
pub struct SecondPersonQuery {
    pub org: OrgId,
    /// The permission the second person must hold (`allow` only).
    pub feature: Feature,
    /// The act's branch; `None` for an org-wide act (all-scope holders only).
    pub branch: Option<BranchId>,
    pub requester: UserId,
    /// Drafter, contributors and deciders of other steps (#2).
    pub excluded: Vec<UserId>,
    /// The case row's `created_at`: the freeze at case creation.
    pub case_created_at: OffsetDateTime,
    /// Resolved `authz.second_person.min_grant_age`, in days.
    pub min_grant_age_days: i32,
}

/// One row of `second_person_candidates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecondPersonCandidate {
    /// `None` only for a `ROLE_EDITED_BY_REQUESTER` row.
    pub user_id: Option<Uuid>,
    pub via: String,
    pub grant_ref: String,
    pub counted: bool,
    pub reason: Option<String>,
    /// `false` for a custom-role row: the authz resolver decides its scope.
    pub scope_final: bool,
}

/// The computed fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecondPersonFact {
    /// The Cedar `other_eligible_holders` Long.
    pub other_eligible_holders: i64,
    /// Who counted, for the `response_due` escalation.
    pub eligible: BTreeSet<Uuid>,
    /// Removals and role edits in the window, for the sole-holder review flag.
    pub review_flags: Vec<SecondPersonCandidate>,
}

const REVIEW_REASONS: [&str; 5] = [
    "DEMOTED_BY_REQUESTER",
    "REMOVED_THEN_INACTIVE",
    "REMOVED_BY_OTHER",
    "REMOVED_BY_UNKNOWN",
    "ROLE_EDITED_BY_REQUESTER",
];

/// A candidate row's identity: user, `via`, `grant_ref`.
pub type RowKey = (Uuid, String, String);

fn key(row: &SecondPersonCandidate) -> Option<RowKey> {
    Some((row.user_id?, row.via.clone(), row.grant_ref.clone()))
}

/// Count the candidates. A counted row whose scope is not final counts only
/// when it is in `confirmed` (its grant reaches the feature over the act's
/// scope).
#[must_use]
pub fn count_second_persons(
    rows: Vec<SecondPersonCandidate>,
    confirmed: &BTreeSet<RowKey>,
) -> SecondPersonFact {
    let eligible: BTreeSet<Uuid> = rows
        .iter()
        .filter(|row| row.counted)
        .filter_map(|row| {
            let user = row.user_id?;
            (row.scope_final || key(row).is_some_and(|k| confirmed.contains(&k))).then_some(user)
        })
        .collect();
    let review_flags = rows
        .into_iter()
        .filter(|row| {
            row.reason
                .as_deref()
                .is_some_and(|reason| REVIEW_REASONS.contains(&reason))
        })
        .collect();
    SecondPersonFact {
        other_eligible_holders: i64::try_from(eligible.len()).unwrap_or(i64::MAX),
        eligible,
        review_flags,
    }
}

/// Compute the fact inside the caller's org-armed decision transaction.
///
/// # Errors
///
/// A database error, or a custom-role grant that does not resolve.
pub async fn second_person_fact_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    query: &SecondPersonQuery,
) -> Result<SecondPersonFact, KernelError> {
    batch::facts_in_tx(tx, std::slice::from_ref(query), None)
        .await?
        .pop()
        .ok_or_else(|| KernelError::internal("missing second-person fact"))
}

mod batch;
pub use batch::facts_in_tx as second_person_facts_in_tx;

/// Whether `grants` hold the feature over the act's scope (org-wide: all).
fn covers(grants: &[EffectiveFeatureGrant], query: &SecondPersonQuery) -> bool {
    grants.iter().any(|grant| {
        grant.feature == query.feature
            && grant.permission == PermissionLevel::Allow
            && match query.branch {
                Some(branch) => grant.branch_scope.allows(branch),
                None => grant.branch_scope == BranchScope::All,
            }
    })
}

fn db_error(err: sqlx::Error) -> KernelError {
    KernelError::internal(format!("second-person fact failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(user: Uuid, counted: bool, reason: Option<&str>, final_: bool) -> SecondPersonCandidate {
        SecondPersonCandidate {
            user_id: Some(user),
            via: "SYSTEM_ROLE".into(),
            grant_ref: "SUPER_ADMIN".into(),
            counted,
            reason: reason.map(Into::into),
            scope_final: final_,
        }
    }

    #[test]
    fn counts_distinct_users_and_flags_window_removals() {
        let (a, b, c, d) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let rows = vec![
            row(a, true, None, true),
            row(a, true, None, true),
            row(b, true, Some("DEMOTED_BY_REQUESTER"), true),
            row(c, true, None, false),
            row(d, false, Some("GRANT_TOO_YOUNG"), true),
            row(d, false, Some("REMOVED_BY_UNKNOWN"), true),
        ];
        let fact = count_second_persons(rows.clone(), &BTreeSet::new());
        assert_eq!(fact.other_eligible_holders, 2);
        assert_eq!(fact.eligible, BTreeSet::from([a, b]));
        assert_eq!(fact.review_flags.len(), 2);
        let other_grant = (c, "SYSTEM_ROLE".to_owned(), "OTHER".to_owned());
        let fact = count_second_persons(rows.clone(), &BTreeSet::from([other_grant]));
        assert_eq!(
            fact.other_eligible_holders, 2,
            "confirmed per row, not per user"
        );
        let this_grant = (c, "SYSTEM_ROLE".to_owned(), "SUPER_ADMIN".to_owned());
        let fact = count_second_persons(rows, &BTreeSet::from([this_grant]));
        assert_eq!(fact.other_eligible_holders, 3);
    }
}

mod holders;
pub use holders::{HolderCapability, PgHolderResolver};
