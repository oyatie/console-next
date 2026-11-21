// SPDX-License-Identifier: LicenseRef-Proprietary
//! `POST /employees/register-facts/query`: set-based batch read of worker
//! register facts + masked birth_date for up to 500 ids or cursor-paged rows.

use console_hr_domain::profile::mask::RevealField;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::exit_reason::exit_reason_code_sql;
use super::ledger_value;
use crate::authz::authorize_hr_org_wide;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

pub const MAX_BATCH_IDS: usize = 500;
pub const DEFAULT_PAGE_LIMIT: i64 = 100;
pub const MAX_PAGE_LIMIT: i64 = 200;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterFactsQueryRequest {
    #[serde(default)]
    pub ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub register_review_required: Option<bool>,
    #[serde(default)]
    pub cursor: Option<Uuid>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RegisterFactsQueryItem {
    pub employee_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub sex: Option<String>,
    pub address: Option<String>,
    pub careers: Value,
    pub exit_reason_code: Option<String>,
    pub exit_reason_label: Option<String>,
    pub register_note: Option<String>,
    pub birth_date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterFactsQueryResponse {
    pub items: Vec<RegisterFactsQueryItem>,
    pub next_cursor: Option<Uuid>,
}

impl HrService {
    pub async fn query_register_facts(
        &self,
        principal: Principal,
        request: RegisterFactsQueryRequest,
    ) -> Result<RegisterFactsQueryResponse, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        if let Some(ids) = &request.ids
            && ids.len() > MAX_BATCH_IDS
        {
            return Err(HrError::validation("ids accepts at most 500 values"));
        }
        if let Some(limit) = request.limit
            && !(1..=MAX_PAGE_LIMIT).contains(&limit)
        {
            return Err(HrError::validation("limit must be between 1 and 200"));
        }
        let ids = request.ids.map(|mut v| {
            v.sort_unstable();
            v.dedup();
            v
        });
        let limit = match (&ids, request.limit) {
            (Some(_), None) => i64::try_from(MAX_BATCH_IDS).unwrap_or(500),
            (_, Some(limit)) => limit,
            (None, None) => DEFAULT_PAGE_LIMIT,
        };
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let review_required = request.register_review_required;
        let cursor = request.cursor;

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                if ids.as_ref().is_some_and(Vec::is_empty) {
                    let me = actor_employee_id(tx, &principal).await?;
                    let event = access_event(
                        &principal,
                        DirectoryAccess::List,
                        &[],
                        me,
                        json!({ "view": "register_facts_batch" }),
                    )?;
                    return Ok((
                        RegisterFactsQueryResponse {
                            items: Vec::new(),
                            next_cursor: None,
                        },
                        vec![event],
                    ));
                }

                let mut q = QueryBuilder::<Postgres>::new(concat!(
                    "SELECT e.id AS employee_id, e.updated_at, f.sex, f.register_note, \
                     x.code AS exit_reason_code, r.label_ko AS tenant_label, \
                     CASE WHEN console_employee_facts(e.org_id, e.id) ? 'birth_date' \
                          THEN (console_employee_facts(e.org_id, e.id)->>'birth_date')::DATE \
                          ELSE e.birth_date END AS birth_date, \
                     CASE WHEN a.id IS NOT NULL THEN \
                       (to_jsonb(a) - '{org_id,id,employee_id,created_by,created_at}'::text[])::text \
                     END AS address, \
                     car.careers \
                     FROM person_employees_current e \
                     LEFT JOIN employee_register_facts f ON f.org_id = e.org_id AND f.employee_id = e.id \
                     LEFT JOIN employee_addresses a ON a.org_id = f.org_id AND a.id = f.address_id \
                     LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
                     CROSS JOIN LATERAL (SELECT ",
                    exit_reason_code_sql!(),
                    " AS code) x \
                     LEFT JOIN reason_codes r ON r.org_id = e.org_id AND r.domain = 'exit_reason' AND r.code = x.code \
                     LEFT JOIN LATERAL ( \
                       SELECT COALESCE(jsonb_agg(jsonb_build_object( \
                         'employer_name', c.employer_name, \
                         'from', to_char(c.from_month, 'YYYY-MM'), \
                         'to', to_char(c.to_month, 'YYYY-MM'), \
                         'position', c.position, \
                         'duty', c.duty, \
                         'leave_reason', c.leave_reason) ORDER BY c.seq), '[]'::jsonb)::text AS careers \
                       FROM employee_careers c \
                       WHERE c.org_id = f.org_id AND c.employee_id = f.employee_id AND c.voided_at IS NULL \
                     ) car ON f.career_none IS NOT NULL \
                     WHERE e.org_id = "
                ));
                q.push_bind(org_uuid);
                if let Some(ids) = ids {
                    q.push(" AND e.id = ANY(");
                    q.push_bind(ids);
                    q.push(")");
                }
                if let Some(req) = review_required {
                    q.push(" AND ");
                    q.push(crate::register_review_sql!());
                    q.push(" = ");
                    q.push_bind(req);
                }
                if let Some(cursor) = cursor {
                    q.push(" AND e.id > ");
                    q.push_bind(cursor);
                }
                q.push(" ORDER BY e.id ASC LIMIT ");
                q.push_bind(limit + 1);

                let mut rows = q.build().fetch_all(tx.as_mut()).await?;
                let page_size = usize::try_from(limit).unwrap_or(100);
                let has_more = rows.len() > page_size;
                if has_more {
                    rows.truncate(page_size);
                }
                let mut items = Vec::with_capacity(rows.len());
                for row in rows {
                    let exit_reason_code: Option<String> = row.try_get("exit_reason_code")?;
                    let tenant_label: Option<String> = row.try_get("tenant_label")?;
                    let exit_reason_label = exit_reason_code
                        .as_deref()
                        .and_then(console_hr_domain::register::exit_reason_label)
                        .map(str::to_owned)
                        .or(tenant_label);
                    let address: Option<String> = row.try_get("address")?;
                    let careers: Option<String> = row.try_get("careers")?;
                    let birth_date: Option<Date> = row.try_get("birth_date")?;
                    items.push(RegisterFactsQueryItem {
                        employee_id: row.try_get("employee_id")?,
                        updated_at: row.try_get("updated_at")?,
                        sex: row.try_get("sex")?,
                        address: address
                            .as_deref()
                            .map(|raw| RevealField::Address.masked(raw)),
                        careers: ledger_value("careers", careers.as_deref()),
                        exit_reason_code,
                        exit_reason_label,
                        register_note: row.try_get("register_note")?,
                        birth_date: birth_date
                            .map(|d| RevealField::BirthDate.masked(&d.to_string())),
                    });
                }
                let next_cursor = if has_more {
                    items.last().map(|item| item.employee_id)
                } else {
                    None
                };
                let subjects: Vec<Uuid> = items.iter().map(|item| item.employee_id).collect();
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &subjects,
                    me,
                    json!({ "view": "register_facts_batch" }),
                )?;
                Ok((
                    RegisterFactsQueryResponse { items, next_cursor },
                    vec![event],
                ))
            })
        })
        .await
    }
}
