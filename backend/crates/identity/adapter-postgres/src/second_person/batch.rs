// SPDX-License-Identifier: LicenseRef-Proprietary
//! Batch the same D0.2 candidate resolver; scope reads are cached per holder, never per case.
use super::*;
use console_platform_authz::access::{load_access_subject, project, tag};
use console_platform_authz::{
    permission_for, resolve_branch_scope_in_tx, resolve_effective_feature_grants_in_tx,
};
use sqlx::Row;
use std::{collections::BTreeMap, str::FromStr};

/// Resolve a set of cases in one candidate query. `viewer` narrows an inbox to one account.
/// All cases must belong to the transaction's tenant.
pub async fn facts_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    queries: &[SecondPersonQuery],
    viewer: Option<UserId>,
) -> Result<Vec<SecondPersonFact>, KernelError> {
    if queries.is_empty() {
        return Ok(Vec::new());
    }
    let input = queries.iter().map(|q| {
        let roles: Vec<_> = Role::ALL.into_iter().filter(|role| permission_for(*role,q.feature)==PermissionLevel::Allow).map(Role::as_str).collect();
        let all: Vec<_> = ALL_SCOPE_ROLES.into_iter().map(Role::as_str).collect();
        let line = tag(q.feature);
        let at = q.case_created_at.format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| KernelError::internal("invalid second-person case time"))?;
        Ok(serde_json::json!({"org":q.org.as_uuid(), "feature":q.feature.as_str(), "roles":roles, "all":all,
            "domain":line.map(|(d,_)|d.as_str()), "level":line.map(|(_,l)|l.as_str()),
            "branch":q.branch.map(|b|*b.as_uuid()), "requester":q.requester.as_uuid(),
            "excluded":q.excluded.iter().map(|u|*u.as_uuid()).collect::<Vec<_>>(), "at":at, "age":q.min_grant_age_days}))
    }).collect::<Result<Vec<_>,KernelError>>()?;
    let rows = sqlx::query(
        "SELECT q.ordinality, c.* FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY q(value,ordinality) \
         CROSS JOIN LATERAL second_person_candidates((q.value->>'org')::uuid, q.value->>'feature', \
         ARRAY(SELECT jsonb_array_elements_text(q.value->'roles')), ARRAY(SELECT jsonb_array_elements_text(q.value->'all')), \
         q.value->>'domain',q.value->>'level',(q.value->>'branch')::uuid,(q.value->>'requester')::uuid, \
         ARRAY(SELECT jsonb_array_elements_text(q.value->'excluded'))::uuid[],(q.value->>'at')::timestamptz, \
         make_interval(days=>(q.value->>'age')::int),make_interval(days=>$3)) c \
         WHERE $2::uuid IS NULL OR c.user_id=$2 ORDER BY q.ordinality")
        .bind(serde_json::json!(input)).bind(viewer.map(|u|*u.as_uuid())).bind(DEMOTION_LOOKBACK_DAYS)
        .fetch_all(tx.as_mut()).await.map_err(db_error)?;
    let mut groups = vec![Vec::new(); queries.len()];
    for row in rows {
        let index = usize::try_from(row.try_get::<i64, _>("ordinality").map_err(db_error)? - 1)
            .map_err(|_| KernelError::internal("invalid second-person position"))?;
        groups[index].push(SecondPersonCandidate {
            user_id: row.try_get("user_id").map_err(db_error)?,
            via: row.try_get("via").map_err(db_error)?,
            grant_ref: row.try_get("grant_ref").map_err(db_error)?,
            counted: row.try_get("counted").map_err(db_error)?,
            reason: row.try_get("reason").map_err(db_error)?,
            scope_final: row.try_get("scope_final").map_err(db_error)?,
        });
    }
    let mut policies = BTreeMap::new();
    let mut access = BTreeMap::new();
    let mut result = Vec::with_capacity(queries.len());
    for (rows, query) in groups.into_iter().zip(queries) {
        let mut confirmed = BTreeSet::new();
        for candidate in rows.iter().filter(|r| r.counted && !r.scope_final) {
            let Some(k) = key(candidate) else {
                continue;
            };
            let user = k.0;
            let holds = match k.1.as_str() {
                "POLICY_ROLE" => {
                    if let std::collections::btree_map::Entry::Vacant(entry) =
                        policies.entry((query.org, user))
                    {
                        let codes: Vec<String> =
                            sqlx::query_scalar("SELECT roles FROM users WHERE org_id=$1 AND id=$2")
                                .bind(query.org.as_uuid())
                                .bind(user)
                                .fetch_one(tx.as_mut())
                                .await
                                .map_err(db_error)?;
                        let roles: Vec<Role> = codes
                            .iter()
                            .filter_map(|c| Role::from_str(c).ok())
                            .collect();
                        let id = UserId::from_uuid(user);
                        let live = resolve_branch_scope_in_tx(tx, id, &roles).await?;
                        entry.insert(
                            resolve_effective_feature_grants_in_tx(tx, query.org, id, &live)
                                .await?,
                        );
                    }
                    covers(&policies[&(query.org, user)], query)
                }
                "ACCESS_GRANT" => {
                    if let std::collections::btree_map::Entry::Vacant(entry) =
                        access.entry((query.org, user))
                    {
                        entry.insert(
                            load_access_subject(tx, query.org, user, OffsetDateTime::now_utc())
                                .await?,
                        );
                    }
                    // Each grant proves its own scope: another, newer grant cannot widen it.
                    let mut subject = access[&(query.org, user)].clone();
                    subject.grants.retain(|g| g.grant_id.to_string() == k.2);
                    covers(&project(&subject).grants, query)
                }
                _ => false,
            };
            if holds {
                confirmed.insert(k);
            }
        }
        let fact = count_second_persons(rows, &confirmed);
        tracing::debug!(business_event="authz.second_person.resolved", org=%query.org,
            feature=query.feature.as_str(),eligible=fact.other_eligible_holders,review_flags=fact.review_flags.len(),"second-person fact resolved");
        result.push(fact);
    }
    Ok(result)
}
