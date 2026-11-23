// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service leave queries: `org_unit`, `team-overlap`, and `approval-preview`.

#[path = "self_service_preview.rs"]
mod preview;

use console_kernel_core::{KernelError, OrgId, UserId};
use console_leave_application::{
    SelfLeaveTeamOverlapQuery, SelfLeaveTeamOverlapView, TeamOverlapMemberView,
};
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{PgLeaveError, PgLeaveStore};

pub(super) async fn require_self_employee(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    requester: UserId,
) -> Result<Uuid, PgLeaveError> {
    let facts = load_facts(tx, org, *requester.as_uuid())
        .await
        .map_err(|_| {
            PgLeaveError::Domain(KernelError::forbidden(
                "self-service access facts are unavailable",
            ))
        })?;
    let Some(employee_id) = facts.linked_employee_id() else {
        return Err(PgLeaveError::Domain(KernelError::forbidden(
            "no active linked employee for self-service leave",
        )));
    };
    let allowed = facts
        .authorize_employee_self_read(employee_id)
        .map_err(|_| {
            PgLeaveError::Domain(KernelError::forbidden("self-service leave read is denied"))
        })?;
    if !allowed {
        return Err(PgLeaveError::Domain(KernelError::forbidden(
            "self-service leave read is denied",
        )));
    }
    Ok(employee_id)
}

pub(super) async fn resolve_employee_unit(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    employee_id: Uuid,
) -> Result<(Option<Uuid>, Option<String>, Option<String>), PgLeaveError> {
    let row = sqlx::query(
        r#"
        SELECT e.org_unit_id,
               NULLIF(btrim(e.org_unit), '') AS raw_org_unit,
               COALESCE(NULLIF(btrim(ou.name), ''), NULLIF(btrim(e.org_unit), '')) AS org_unit
        FROM person_employees_current e
        LEFT JOIN LATERAL (
            SELECT r.attributes->>'name' AS name
            FROM org_unit_revisions r
            WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
            ORDER BY r.version DESC
            LIMIT 1
        ) ou ON e.org_unit_id IS NOT NULL
        WHERE e.org_id = $1 AND e.id = $2
        "#,
    )
    .bind(org.as_uuid())
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Ok((None, None, None));
    };
    Ok((
        row.try_get("org_unit_id")?,
        row.try_get("raw_org_unit")?,
        row.try_get("org_unit")?,
    ))
}

impl PgLeaveStore {
    pub(crate) async fn resolve_self_org_unit(
        &self,
        org: OrgId,
        employee_id: Uuid,
    ) -> Result<Option<String>, PgLeaveError> {
        with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let (_, _, org_unit) = resolve_employee_unit(tx, org, employee_id).await?;
                Ok(org_unit)
            })
        })
        .await
    }

    pub async fn get_self_team_overlap(
        &self,
        query: SelfLeaveTeamOverlapQuery,
    ) -> Result<SelfLeaveTeamOverlapView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let employee_id = require_self_employee(tx, org, query.requester).await?;
                let (org_unit_id, raw_org_unit, org_unit) =
                    resolve_employee_unit(tx, org, employee_id).await?;
                if org_unit_id.is_none() && raw_org_unit.is_none() {
                    return Ok(SelfLeaveTeamOverlapView {
                        org_unit: None,
                        active_count: 0,
                        out_count: 0,
                        members_out: Vec::new(),
                    });
                }

                let active_count: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(*)::bigint
                    FROM person_employees_current te
                    WHERE te.org_id = $1
                      AND te.merged_into_employee_id IS NULL
                      AND te.employment_status = 'ACTIVE'
                      AND (
                          ($2::uuid IS NOT NULL AND te.org_unit_id = $2)
                          OR ($2::uuid IS NULL AND te.org_unit_id IS NULL AND NULLIF(btrim(te.org_unit), '') = $3)
                      )
                    "#,
                )
                .bind(org.as_uuid())
                .bind(org_unit_id)
                .bind(raw_org_unit.as_deref())
                .fetch_one(tx.as_mut())
                .await?;

                let out_count: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(DISTINCT lr.subject_employee_id)::bigint
                    FROM leave_requests lr
                    JOIN person_employees_current te
                      ON te.org_id = lr.org_id AND te.id = lr.subject_employee_id
                    WHERE lr.org_id = $1
                      AND lr.subject_employee_id <> $2
                      AND lr.status IN ('pending', 'approved')
                      AND lr.start_date <= $6
                      AND lr.end_date >= $5
                      AND te.merged_into_employee_id IS NULL
                      AND te.employment_status = 'ACTIVE'
                      AND (
                          ($3::uuid IS NOT NULL AND te.org_unit_id = $3)
                          OR ($3::uuid IS NULL AND te.org_unit_id IS NULL AND NULLIF(btrim(te.org_unit), '') = $4)
                      )
                    "#,
                )
                .bind(org.as_uuid())
                .bind(employee_id)
                .bind(org_unit_id)
                .bind(raw_org_unit.as_deref())
                .bind(query.start_date)
                .bind(query.end_date)
                .fetch_one(tx.as_mut())
                .await?;

                let rows = sqlx::query(
                    r#"
                    SELECT DISTINCT ON (te.id) te.id AS employee_id, te.name
                    FROM leave_requests lr
                    JOIN person_employees_current te
                      ON te.org_id = lr.org_id AND te.id = lr.subject_employee_id
                    WHERE lr.org_id = $1
                      AND lr.subject_employee_id <> $2
                      AND lr.status IN ('pending', 'approved')
                      AND lr.start_date <= $6
                      AND lr.end_date >= $5
                      AND te.merged_into_employee_id IS NULL
                      AND te.employment_status = 'ACTIVE'
                      AND (
                          ($3::uuid IS NOT NULL AND te.org_unit_id = $3)
                          OR ($3::uuid IS NULL AND te.org_unit_id IS NULL AND NULLIF(btrim(te.org_unit), '') = $4)
                      )
                    ORDER BY te.id, te.name ASC
                    "#,
                )
                .bind(org.as_uuid())
                .bind(employee_id)
                .bind(org_unit_id)
                .bind(raw_org_unit.as_deref())
                .bind(query.start_date)
                .bind(query.end_date)
                .fetch_all(tx.as_mut())
                .await?;

                let mut members_out: Vec<TeamOverlapMemberView> = rows
                    .iter()
                    .map(|row| {
                        Ok(TeamOverlapMemberView {
                            employee_id: row.try_get("employee_id")?,
                            name: row.try_get("name")?,
                        })
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()?;
                members_out.sort_by(|a, b| {
                    a.name
                        .cmp(&b.name)
                        .then_with(|| a.employee_id.cmp(&b.employee_id))
                });
                members_out.truncate(50);

                Ok(SelfLeaveTeamOverlapView {
                    org_unit,
                    active_count,
                    out_count,
                    members_out,
                })
            })
        })
        .await
    }
}
