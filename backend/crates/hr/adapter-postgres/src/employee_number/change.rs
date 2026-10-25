// SPDX-License-Identifier: LicenseRef-Proprietary
//! A 사번 변경 of one employee, its history and the lookup that still finds
//! a person by an old 사번 (alias).

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_ontology_canonical_adapter_postgres::employee_correction::correct_employee_head_in_tx;
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::facts::{lock_numbers, taken_numbers};
use super::{audit, check_reason, coded};
use crate::authz::{authorize_hr_org_wide, authorize_hr_person, hr_reach};
use crate::clock::today_kst;
use crate::{HrError, HrService};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmployeeNumberChangeRequest {
    pub new_number: String,
    /// `YYYY-MM-DD`, today or earlier (a future change is not scheduled).
    pub effective_date: String,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// The employee's `updated_at` as last read (RFC 3339).
    pub expected_updated_at: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EmployeeNumberChange {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub from_number: Option<String>,
    pub to_number: String,
    pub effective_date: Date,
    pub reason_code: String,
    pub batch_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub changed_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub undone_at: Option<OffsetDateTime>,
}

/// Who a 사번 finds: the current holder, else the person it was an alias of.
#[derive(Debug, Serialize)]
pub struct EmployeeNumberMatch {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    /// `current` or `alias`.
    pub matched_by: &'static str,
}

impl HrService {
    /// # Errors
    /// 403; 404 unknown employee; 409 stale version, `employee_number_taken`;
    /// 422 `employee_number_unchanged`, `effective_date_in_future`, reason.
    pub async fn change_employee_number(
        &self,
        principal: Principal,
        employee_id: Uuid,
        request: EmployeeNumberChangeRequest,
    ) -> Result<EmployeeNumberChange, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let org_uuid = *org.as_uuid();
        let number = request.new_number.trim().to_owned();
        if number.is_empty() || number.chars().count() > 40 {
            return Err(HrError::validation("new_number must be 1-40 characters"));
        }
        let effective = parse_yyyy_mm_dd(&request.effective_date)?;
        if effective > today_kst() {
            return Err(coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                "effective_date_in_future",
                "a 사번 change takes effect today or earlier",
            ));
        }
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee_id).await?;
                lock_numbers(tx, org_uuid).await?;
                crate::employee_state::require_editable(tx.as_mut(), org_uuid, employee_id).await?;
                let head: Option<(Option<String>, OffsetDateTime)> = sqlx::query_as(
                    "SELECT employee_number, updated_at FROM employees WHERE org_id = $1 AND id = $2 FOR UPDATE",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let (current, updated_at) = head.ok_or_else(|| {
                    HrError::from_kernel(console_kernel_core::KernelError::not_found("employee was not found in this organization"))
                })?;
                if updated_at.format(&Rfc3339).ok().as_deref() != Some(request.expected_updated_at.trim()) {
                    return Err(coded(StatusCode::CONFLICT, "stale_revision", "the employee changed since it was read"));
                }
                if current.as_deref() == Some(number.as_str()) {
                    return Err(coded(StatusCode::UNPROCESSABLE_ENTITY, "employee_number_unchanged", "that is already the 사번"));
                }
                crate::own_record::own_record_guard(tx, org, actor, employee_id, Feature::EmployeeDirectoryManage).await?;
                check_reason(tx, org, request.reason_code.trim(), request.note.as_deref()).await?;
                let own: Vec<String> = sqlx::query_scalar(
                    "SELECT from_number FROM employee_number_changes WHERE org_id = $1 \
                       AND employee_id = $2 AND undone_at IS NULL AND from_number IS NOT NULL",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_all(tx.as_mut())
                .await?;
                if !own.contains(&number) && taken_numbers(tx, org_uuid).await?.contains(&number) {
                    return Err(coded(StatusCode::CONFLICT, "employee_number_taken", "someone holds or held that 사번"));
                }
                let change: EmployeeNumberChange = sqlx::query_as(
                    "INSERT INTO employee_number_changes (org_id, employee_id, from_number, to_number, \
                       effective_date, reason_code, note, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
                     RETURNING id, employee_id, from_number, to_number, effective_date, reason_code, \
                       batch_id, changed_at, undone_at",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .bind(&current)
                .bind(&number)
                .bind(effective)
                .bind(request.reason_code.trim())
                .bind(request.note.as_deref())
                .bind(*actor.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                correct_employee_head_in_tx(tx, org_uuid, employee_id, &[("employee_number", Some(number.as_str()))])
                    .await?;
                let event = audit(org, actor, "employee.employee_number_change", "employee", employee_id.to_string(), json!({
                    "change_id": change.id, "effective_date": effective.to_string(),
                    "reason_code": change.reason_code, "alias_kept": current.is_some(),
                }))?;
                Ok((change, vec![event]))
            })
        })
        .await
    }

    /// The 사번 history of one employee (변경/발령 이력), oldest first.
    pub async fn employee_number_history(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<Vec<EmployeeNumberChange>, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org_uuid = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                Ok(sqlx::query_as(
                    "SELECT id, employee_id, from_number, to_number, effective_date, reason_code, \
                       batch_id, changed_at, undone_at FROM employee_number_changes \
                      WHERE org_id = $1 AND employee_id = $2 ORDER BY changed_at, id",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await
    }

    /// Who a 사번 finds: its holder, else the person whose earlier 사번 it was.
    pub async fn find_by_employee_number(
        &self,
        principal: Principal,
        number: String,
    ) -> Result<Option<EmployeeNumberMatch>, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org_uuid = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let number = number.trim().to_owned();
                let found: Option<(Uuid, Option<String>, bool)> = sqlx::query_as(
                    "SELECT id, employee_number, true FROM employees WHERE org_id = $1 AND employee_number = $2 \
                     UNION ALL \
                     SELECT e.id, e.employee_number, false FROM employee_number_changes c \
                       JOIN employees e ON e.org_id = c.org_id AND e.id = c.employee_id \
                      WHERE c.org_id = $1 AND c.from_number = $2 AND c.undone_at IS NULL \
                     ORDER BY 3 DESC LIMIT 1",
                )
                .bind(org_uuid)
                .bind(&number)
                .fetch_optional(tx.as_mut())
                .await?;
                Ok(found.map(|(employee_id, employee_number, current)| EmployeeNumberMatch {
                    employee_id,
                    employee_number,
                    matched_by: if current { "current" } else { "alias" },
                }))
            })
        })
        .await
    }
}
