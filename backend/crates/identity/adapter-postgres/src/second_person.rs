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
use std::str::FromStr;

use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId, UserId};
use console_platform_authz::access::{load_access_subject, project, tag};
use console_platform_authz::{
    EffectiveFeatureGrant, Feature, PermissionLevel, Role, permission_for,
    resolve_branch_scope_in_tx, resolve_effective_feature_grants_in_tx,
};
use sqlx::{Postgres, Row, Transaction};
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
    let allow_roles: Vec<&str> = Role::ALL
        .into_iter()
        .filter(|role| permission_for(*role, query.feature) == PermissionLevel::Allow)
        .map(Role::as_str)
        .collect();
    let all_scope_roles: Vec<&str> = ALL_SCOPE_ROLES.into_iter().map(Role::as_str).collect();
    let excluded: Vec<Uuid> = query.excluded.iter().map(|user| *user.as_uuid()).collect();
    // A fenced operation has no (domain, level): no access grant reaches it.
    let line = tag(query.feature);
    let rows = sqlx::query(
        "SELECT user_id, via, grant_ref, counted, reason, scope_final \
         FROM second_person_candidates($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
              make_interval(days => $11), make_interval(days => $12))",
    )
    .bind(*query.org.as_uuid())
    .bind(query.feature.as_str())
    .bind(&allow_roles)
    .bind(&all_scope_roles)
    .bind(line.map(|(domain, _)| domain.as_str()))
    .bind(line.map(|(_, level)| level.as_str()))
    .bind(query.branch.map(|branch| *branch.as_uuid()))
    .bind(*query.requester.as_uuid())
    .bind(&excluded)
    .bind(query.case_created_at)
    .bind(query.min_grant_age_days)
    .bind(DEMOTION_LOOKBACK_DAYS)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db_error)?
    .into_iter()
    .map(|row| {
        Ok(SecondPersonCandidate {
            user_id: row.try_get("user_id")?,
            via: row.try_get("via")?,
            grant_ref: row.try_get("grant_ref")?,
            counted: row.try_get("counted")?,
            reason: row.try_get("reason")?,
            scope_final: row.try_get("scope_final")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()
    .map_err(db_error)?;

    let mut confirmed = BTreeSet::new();
    let pending: Vec<RowKey> = rows
        .iter()
        .filter(|row| row.counted && !row.scope_final)
        .filter_map(key)
        .collect();
    let policy_users: BTreeSet<Uuid> = pending
        .iter()
        .filter(|(_, via, _)| via == "POLICY_ROLE")
        .map(|(user, _, _)| *user)
        .collect();
    for user in policy_users {
        // The candidate's own live scope, exactly as their principal would get
        // it; the resolver only narrows from there. An unknown role code is
        // dropped, which can only narrow the scope.
        let codes: Vec<String> =
            sqlx::query_scalar("SELECT roles FROM users WHERE org_id = $1 AND id = $2")
                .bind(*query.org.as_uuid())
                .bind(user)
                .fetch_one(tx.as_mut())
                .await
                .map_err(db_error)?;
        let roles: Vec<Role> = codes
            .iter()
            .filter_map(|code| Role::from_str(code).ok())
            .collect();
        let id = UserId::from_uuid(user);
        let live = resolve_branch_scope_in_tx(tx, id, &roles).await?;
        let grants = resolve_effective_feature_grants_in_tx(tx, query.org, id, &live).await?;
        if covers(&grants, query) {
            confirmed.extend(
                pending
                    .iter()
                    .filter(|k| k.0 == user && k.1 == "POLICY_ROLE")
                    .cloned(),
            );
        }
    }
    // An access grant counts on its own: Cedar decides that grant alone (its
    // dates, role, phase and scope chain), so another grant of the same holder
    // that is too young or not yet noticed never lends it a wider scope.
    let now = OffsetDateTime::now_utc();
    for row in pending.iter().filter(|(_, via, _)| via == "ACCESS_GRANT") {
        let mut subject = load_access_subject(tx, query.org, row.0, now).await?;
        subject
            .grants
            .retain(|grant| grant.grant_id.to_string() == row.2);
        if covers(&project(&subject).grants, query) {
            confirmed.insert(row.clone());
        }
    }
    let fact = count_second_persons(rows, &confirmed);
    tracing::debug!(business_event="authz.second_person.resolved", org=%query.org,
        feature=query.feature.as_str(), eligible=fact.other_eligible_holders,
        review_flags=fact.review_flags.len(), "second-person fact resolved");
    Ok(fact)
}

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

/// What a live holder must be able to do. Case-age/notice eligibility remains
/// the separate D0.2 fact above; current-holder checks must not borrow that age.
#[derive(Clone, Copy)]
pub enum HolderCapability {
    Feature {
        feature: Feature,
        branch: Option<BranchId>,
    },
    OrgChangeDecide,
    AccessAdmin,
}

/// Identity's transaction-bound implementation of the application holder port.
pub struct PgHolderResolver<'a, 't> {
    pub tx: &'a mut Transaction<'t, Postgres>,
    pub org: OrgId,
    pub capability: HolderCapability,
    pub exclude_account: Option<Uuid>,
    pub exclude_employee: Option<Uuid>,
    pub include_ops: bool,
    pub now: OffsetDateTime,
}

impl console_identity_application::holders::HolderResolver for PgHolderResolver<'_, '_> {
    async fn resolve(&mut self) -> Result<BTreeSet<Uuid>, KernelError> {
        use console_platform_authz::access::{AccessSlice, Domain, Level, NodePath, action_group};
        let accounts: Vec<Uuid> = sqlx::query_scalar(
            "SELECT u.id FROM users u WHERE u.org_id=$1 AND u.is_active
               AND ($2::uuid IS NULL OR u.id <> $2)
               AND ($3::uuid IS NULL OR u.employee_id IS DISTINCT FROM $3)
               AND ($4 OR NOT u.is_tenant_ops)
               AND (u.is_tenant_ops OR EXISTS (SELECT 1 FROM access_grants g
                    WHERE g.org_id=u.org_id AND g.account_id=u.id AND g.status='ACTIVE'
                      AND g.valid_from <= $5 AND (g.valid_to IS NULL OR g.valid_to > $5)))
             ORDER BY u.id FOR SHARE OF u",
        )
        .bind(self.org.as_uuid())
        .bind(self.exclude_account)
        .bind(self.exclude_employee)
        .bind(self.include_ops)
        .bind(self.now)
        .fetch_all(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        let mut holders = BTreeSet::new();
        for account in accounts {
            let subject = load_access_subject(self.tx, self.org, account, self.now).await?;
            let holds = match self.capability {
                HolderCapability::Feature { feature, branch } => {
                    subject.is_ops
                        || project(&subject).grants.iter().any(|g| {
                            g.feature == feature
                                && g.permission == PermissionLevel::Allow
                                && branch.map_or(g.branch_scope == BranchScope::All, |b| {
                                    g.branch_scope.allows(b)
                                })
                        })
                }
                HolderCapability::OrgChangeDecide | HolderCapability::AccessAdmin => {
                    let (domain, level) = match self.capability {
                        HolderCapability::OrgChangeDecide => (Domain::Org, Level::Approve),
                        _ => (Domain::Access, Level::Edit),
                    };
                    AccessSlice::compile(&subject)
                        .and_then(|s| {
                            s.allows(&action_group(domain, level), &NodePath::tenant(self.org))
                        })
                        .unwrap_or(false)
                }
            };
            if holds {
                holders.insert(account);
            }
        }
        tracing::debug!(business_event="authz.holders.resolved", org=%self.org, holders=holders.len(), "current holders resolved");
        Ok(holders)
    }
}
