use super::filing_query::non_employee_types;
use crate::authz::push_reach_at_unit;
use crate::authz::{Tier, hr_reach_in, out_of_scope, place_in_reach};
use crate::clock::today_kst;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_export::{EXPORT_PURPOSES, export_purpose_required};
use crate::directory::read_export_register::{ExportLayout, REGISTER_SELECT, register_cells};
use crate::{HrError, HrService};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterQuery {
    pub workplace_id: Uuid,
    pub as_of: String,
    pub after: Option<Uuid>,
    pub limit: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct RegisterRow {
    pub employee_id: Uuid,
    pub cells: Vec<String>,
    pub missing: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct RegisterPage {
    pub as_of: String,
    pub workplace_id: Uuid,
    pub workplace_name: String,
    pub headers: Vec<String>,
    pub items: Vec<RegisterRow>,
    pub total: i64,
    pub next: Option<Uuid>,
}

const DAY: &str = "(SELECT on_date FROM point)";
const FROM: &str = " FROM person_employees_current e \
 JOIN LATERAL (SELECT a.* FROM employment_assignments a \
   WHERE a.org_id = e.org_id AND a.employee_id = e.id \
     AND a.superseded_at IS NULL AND a.valid_from <= (SELECT on_date FROM point) \
   ORDER BY a.valid_from DESC LIMIT 1) ea ON TRUE \
 LEFT JOIN LATERAL (SELECT head.* FROM employment_heads head \
   WHERE head.org_id = e.org_id AND head.employee_id = e.id \
     AND head.hire_date <= (SELECT on_date FROM point) AND head.legal_entity_id = ea.legal_entity_id \
     AND (ea.employment_id IS NULL OR head.id = ea.employment_id) \
   ORDER BY head.hire_date DESC LIMIT 1) h ON TRUE \
 LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
 LEFT JOIN LATERAL (SELECT l.* FROM employee_lifecycle_events l WHERE l.org_id = e.org_id AND l.employee_id = e.id \
   AND l.state = 'APPLIED' AND l.effective_date::date > (SELECT on_date FROM point) \
   AND l.event_type IN ('TRANSFER','GROUP_TRANSFER','PROMOTE','APPOINT','EMPLOYMENT_TYPE_CHANGE','CONTRACT_RENEWAL') \
   AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id = l.org_id AND v.voids_event_id = l.id AND v.state = 'APPLIED') \
   ORDER BY l.effective_date, l.created_at LIMIT 1) later ON TRUE \
 WHERE e.org_id = (SELECT org_id FROM point) AND e.voided_at IS NULL \
   AND ea.workplace_id = (SELECT workplace_id FROM point) \
   AND (COALESCE(h.hire_date, e.hire_on) IS NULL OR COALESCE(h.hire_date, e.hire_on) <= (SELECT on_date FROM point))";

pub(super) fn gaps(cells: &[String]) -> Vec<String> {
    let mut missing = [
        (1, "name"),
        (2, "sex"),
        (3, "birth"),
        (4, "address"),
        (8, "job"),
        (9, "hire"),
        (11, "contract"),
        (15, "history"),
    ]
    .into_iter()
    .filter(|(n, _)| cells.get(*n).is_none_or(|s| s.is_empty()))
    .map(|(_, key)| key.to_owned())
    .collect::<Vec<_>>();
    if cells.get(13).is_some_and(|s| !s.is_empty()) && cells.get(14).is_none_or(|s| s.is_empty()) {
        missing.push("exit".into());
    }
    missing
}

impl HrService {
    pub async fn worker_register(
        &self,
        p: Principal,
        query: RegisterQuery,
    ) -> Result<RegisterPage, HrError> {
        self.register_read(p, query, None).await
    }
    pub(super) async fn register_read(
        &self,
        p: Principal,
        query: RegisterQuery,
        purpose: Option<String>,
    ) -> Result<RegisterPage, HrError> {
        let reach = hr_reach_in(&p, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        let export_reach = purpose
            .as_ref()
            .map(|_| hr_reach_in(&p, Feature::ExcelDownload, Tier::Branch))
            .transpose()?;
        let on = parse_yyyy_mm_dd(&query.as_of)?;
        if on > today_kst() {
            return Err(HrError::validation("as_of cannot be later than today"));
        }
        let all = purpose.is_some();
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| Box::pin(async move {
            if purpose.as_ref().is_some_and(|s| !EXPORT_PURPOSES.contains(&s.as_str())) {
                let me = actor_employee_id(tx, &p).await?;
                let event = access_event(&p, DirectoryAccess::DownloadRefused, &[], me, json!({"code":"export_purpose_required", "view":"worker_register"}))?;
                return Ok((Err(export_purpose_required()), vec![event]));
            }
            let workplace_name: Option<String> = sqlx::query_scalar("SELECT name FROM workplace_revisions WHERE org_id = $1 AND workplace_id = $2 AND effective_from <= $3 ORDER BY effective_from DESC, version DESC LIMIT 1")
                .bind(p.org_id.as_uuid()).bind(query.workplace_id).bind(on).fetch_optional(tx.as_mut()).await?;
            let workplace_name = match workplace_name {
                Some(name) => name,
                None => sqlx::query_scalar("SELECT name FROM workplace_revisions WHERE org_id=$1 AND workplace_id=$2 ORDER BY effective_from, version LIMIT 1")
                    .bind(p.org_id.as_uuid()).bind(query.workplace_id).fetch_optional(tx.as_mut()).await?
                    .ok_or_else(|| out_of_scope(&p, Feature::EmployeeDirectoryManage))?,
            };
            // The register reuses the CSV's field mapping, with dated employment facts.
            let select = REGISTER_SELECT
                .replacen("SELECT e.employee_number", "SELECT e.id AS employee_id, e.employee_number", 1)
                .replace("(now() AT TIME ZONE 'Asia/Seoul')::date", DAY)
                .replace("e.hire_on", "COALESCE(h.hire_date, e.hire_on)")
                .replace("e.exit_on", &format!("CASE WHEN COALESCE(h.exit_date, e.exit_on) <= {DAY} THEN COALESCE(h.exit_date, e.exit_on) END"))
                .replace("e.org_unit, e.job", "CASE WHEN later.id IS NOT NULL THEN later.from_org_unit ELSE e.org_unit END AS org_unit, CASE WHEN later.id IS NOT NULL THEN later.from_job ELSE e.job END AS job")
                .replace("AND r.state = 'APPLIED'", &format!("AND r.state = 'APPLIED' AND r.effective_date::date <= {DAY}"))
                .replace("AND NOT EXISTS (SELECT 1 FROM employee_contracts", &format!("AND c.start_date <= {DAY} AND NOT EXISTS (SELECT 1 FROM employee_contracts"))
                .replace("AND s.supersedes_id = c.id", &format!("AND s.supersedes_id = c.id AND s.start_date <= {DAY}"))
                .replace("CASE WHEN p.contract_start_date IS NOT NULL OR p.contract_end_date IS NOT NULL", &format!("CASE WHEN p.contract_start_date <= {DAY} AND (p.contract_start_date IS NOT NULL OR p.contract_end_date IS NOT NULL)"))
                .replace("AND c.voided_at IS NULL", &format!("AND c.voided_at IS NULL AND c.from_month <= {DAY}"));
            let mut q = QueryBuilder::<Postgres>::new("WITH point AS (SELECT ");
            q.push_bind(on).push("::date AS on_date, ").push_bind(query.workplace_id).push("::uuid AS workplace_id, ")
                .push_bind(*p.org_id.as_uuid()).push("::uuid AS org_id), filtered AS (").push(select)
                .push(", count(*) OVER () AS total").push(FROM)
                .push(" AND (p.employment_type IS NULL OR p.employment_type <> ALL(")
                .push_bind(non_employee_types())
                .push(")) AND ");
            let unit = "CASE WHEN later.id IS NOT NULL THEN later.from_org_unit_id ELSE e.org_unit_id END";
            push_reach_at_unit(&mut q, &reach, unit);
            if let Some(export_reach) = &export_reach { q.push(" AND "); push_reach_at_unit(&mut q, export_reach, unit); }
            q.push(") SELECT * FROM filtered");
            if !all && let Some(after) = query.after { q.push(" WHERE employee_id > ").push_bind(after); }
            q.push(" ORDER BY employee_id");
            let limit = query.limit.unwrap_or(100).clamp(1, 200);
            if !all { q.push(" LIMIT ").push_bind(i64::try_from(limit).unwrap_or(200) + 1); }
            let rows = q.build().fetch_all(tx.as_mut()).await?;
            let total = rows.first().map(|r| r.try_get::<i64, _>("total")).transpose()?.unwrap_or(0);
            if total == 0 && !place_in_reach(tx, &reach, None, Some(query.workplace_id), None).await? {
                return Err(out_of_scope(&p, Feature::EmployeeDirectoryManage));
            }
            let more = !all && rows.len() > limit;
            let mut items = Vec::new();
            for row in rows.into_iter().take(if all {usize::MAX} else {limit}) {
                let mut cells = register_cells(&row, !all)?;
                if cells[13].is_empty() { cells[14].clear(); }
                items.push(RegisterRow { employee_id: row.try_get("employee_id")?, missing: gaps(&cells), cells });
            }
            let ids = items.iter().map(|i| i.employee_id).collect::<Vec<_>>();
            let me = actor_employee_id(tx, &p).await?;
            let event = access_event(&p, if all {DirectoryAccess::Download} else {DirectoryAccess::List}, &ids, me,
                json!({"view":"worker_register", "as_of":query.as_of, "workplace_id":query.workplace_id, "export_purpose":purpose, "row_count":items.len()}))?;
            let next = items.last().filter(|_| more).map(|i| i.employee_id);
            let page = RegisterPage {as_of: query.as_of, workplace_id: query.workplace_id, workplace_name,
                headers: ExportLayout::Register.header().trim_end().split(',').map(str::to_owned).collect(), items, total, next};
            Ok((Ok(page), vec![event]))
        })).await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gaps_are_nonblocking_and_optional_notes_and_unemployed_exit_do_not_count() {
        let mut cells = vec![String::new(); 17];
        assert_eq!(gaps(&cells).len(), 8);
        for n in [1, 2, 3, 4, 8, 9, 11, 15] {
            cells[n] = "recorded".into();
        }
        assert!(gaps(&cells).is_empty());
        cells[13] = "2026-10-01".into();
        assert_eq!(gaps(&cells), vec!["exit"]);
    }
}
