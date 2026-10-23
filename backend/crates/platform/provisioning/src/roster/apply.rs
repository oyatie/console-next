use std::collections::{BTreeMap, BTreeSet};

use crate::{
    BranchRef, IssueMode, NormalizedRosterUser, ProvisioningError, RosterImportReport,
    issue_bootstrap_if_needed_tx,
};
use console_kernel_core::OrgId;
use console_platform_auth::lock_account_tx;
use sqlx::{Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub(crate) async fn apply_roster_tx(
    tx: &mut Transaction<'_, Postgres>,
    users: Vec<NormalizedRosterUser>,
    now: OffsetDateTime,
    bootstrap_ttl: Duration,
) -> Result<RosterImportReport, ProvisioningError> {
    let mut users = users;
    users.sort_by(|left, right| left.phone.cmp(&right.phone));
    let mut mapping = BTreeMap::new();
    for user in &users {
        let id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE phone=$1 AND org_id=$2")
                .bind(&user.phone)
                .bind(*OrgId::one().as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        mapping.insert(user.phone.clone(), id);
    }
    let existing: BTreeSet<Uuid> = mapping.values().filter_map(|id| *id).collect();
    for id in existing {
        if lock_account_tx(tx, OrgId::one(), id).await?.is_none() {
            return Err(ProvisioningError::Conflict(
                "roster Account disappeared".into(),
            ));
        }
    }
    for (phone, original) in &mapping {
        let current: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE phone=$1 AND org_id=$2")
                .bind(phone)
                .bind(*OrgId::one().as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        if current != *original {
            return Err(ProvisioningError::Conflict(
                "roster Account mapping changed".into(),
            ));
        }
    }
    let mut resolved_branches: BTreeMap<(String, String), Uuid> = BTreeMap::new();
    let mut seen_branch_keys = BTreeSet::new();
    for user in &users {
        for branch_ref in &user.branches {
            let branch_key = (branch_ref.region.clone(), branch_ref.branch.clone());
            if seen_branch_keys.insert(branch_key.clone()) {
                let branch_id = resolve_branch_tx(tx, &user.phone, branch_ref).await?;
                resolved_branches.insert(branch_key, branch_id);
            }
        }
    }

    let mut report = RosterImportReport::default();

    for user in users {
        let desired_branches = user
            .branches
            .iter()
            .filter_map(|branch_ref| {
                resolved_branches
                    .get(&(branch_ref.region.clone(), branch_ref.branch.clone()))
                    .copied()
            })
            .collect::<BTreeSet<_>>();

        // Frozen identity only: never adopt an intervening phone match.
        let existing = if let Some(id) = mapping[&user.phone] {
            Some(
                sqlx::query(
                    "SELECT id, display_name, roles, team FROM person_accounts_current WHERE id=$1 AND org_id=$2",
                )
                .bind(id)
                .bind(*OrgId::one().as_uuid())
                .fetch_one(tx.as_mut())
                .await?,
            )
        } else {
            None
        };

        let user_id = if let Some(row) = existing {
            let user_id: Uuid = row.try_get("id")?;
            let existing_display_name: String = row.try_get("display_name")?;
            let existing_roles: Vec<String> = row.try_get("roles")?;
            let existing_team: Option<String> = row.try_get("team")?;

            if existing_display_name != user.display_name
                || existing_roles != user.roles
                || existing_team != user.team
            {
                sqlx::query(
                    r#"
                    UPDATE users
                    SET display_name = $1, roles = $2, team = $3
                    WHERE id = $4
                    "#,
                )
                .bind(&user.display_name)
                .bind(&user.roles)
                .bind(&user.team)
                .bind(user_id)
                .execute(tx.as_mut())
                .await?;
                report.users_updated += 1;
            } else {
                report.users_unchanged += 1;
            }

            user_id
        } else {
            let user_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO users (display_name, phone, roles, team, org_id)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                "#,
            )
            .bind(&user.display_name)
            .bind(&user.phone)
            .bind(&user.roles)
            .bind(&user.team)
            .bind(*OrgId::one().as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
            report.users_created += 1;

            if let Some(issue) = issue_bootstrap_if_needed_tx(
                tx,
                user_id,
                OrgId::one(),
                now,
                bootstrap_ttl,
                IssueMode::SkipIfPresent,
            )
            .await?
            {
                report.bootstrap_credentials_issued.push(issue);
            }

            user_id
        };

        let existing_branch_rows: Vec<Uuid> =
            sqlx::query_scalar("SELECT branch_id FROM user_branches WHERE user_id = $1")
                .bind(user_id)
                .fetch_all(tx.as_mut())
                .await?;
        let existing_branches = existing_branch_rows.into_iter().collect::<BTreeSet<_>>();

        for branch_id in desired_branches.difference(&existing_branches) {
            sqlx::query(
                "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
            )
            .bind(user_id)
            .bind(*branch_id)
            .bind(*OrgId::one().as_uuid())
            .execute(tx.as_mut())
            .await?;
            report.branch_memberships_added += 1;
        }

        for branch_id in existing_branches.difference(&desired_branches) {
            sqlx::query("DELETE FROM user_branches WHERE user_id = $1 AND branch_id = $2")
                .bind(user_id)
                .bind(*branch_id)
                .execute(tx.as_mut())
                .await?;
            report.branch_memberships_removed += 1;
        }
    }

    Ok(report)
}

async fn resolve_branch_tx(
    tx: &mut Transaction<'_, Postgres>,
    phone: &str,
    branch_ref: &BranchRef,
) -> Result<Uuid, ProvisioningError> {
    sqlx::query_scalar(
        r#"
        SELECT b.id
        FROM branches b
        JOIN regions r ON r.id = b.region_id
        WHERE r.name = $1 AND b.name = $2
        "#,
    )
    .bind(&branch_ref.region)
    .bind(&branch_ref.branch)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| ProvisioningError::UnknownBranch {
        phone: phone.to_owned(),
        region: branch_ref.region.clone(),
        branch: branch_ref.branch.clone(),
    })
}
