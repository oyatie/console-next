//! `GET /hr/org-chart`: company -> unit -> position grouping (moved from
//! `app/src/hr.rs`, R2-people). An employee with a 법인 assignment groups
//! under that 법인 by id and its current name; one without keeps the legacy
//! company-text group (E-S3a).

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::metrics::record_hr_read;
use crate::{HrError, HrService, assignment_lateral};

#[derive(Debug, Serialize)]
pub struct HrOrgChartResponse {
    pub companies: Vec<HrOrgChartCompany>,
}

#[derive(Debug, Serialize)]
pub struct HrOrgChartCompany {
    /// The 법인 this group is; null for a legacy company-text group.
    pub legal_entity_id: Option<Uuid>,
    pub company: String,
    pub total: i64,
    pub active: i64,
    pub units: Vec<HrOrgChartUnit>,
}

#[derive(Debug, Serialize)]
pub struct HrOrgChartUnit {
    /// The canonical OrgUnit this group is; null for legacy free-text groups.
    pub org_unit_id: Option<Uuid>,
    pub name: String,
    pub total: i64,
    pub positions: Vec<HrOrgChartPosition>,
}

#[derive(Debug, Serialize)]
pub struct HrOrgChartPosition {
    pub title: String,
    pub total: i64,
    pub employees: Vec<HrOrgChartEmployee>,
}

#[derive(Debug, Serialize)]
pub struct HrOrgChartEmployee {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    pub status: String,
}

pub fn find_or_insert_company(
    companies: &mut Vec<HrOrgChartCompany>,
    legal_entity_id: Option<Uuid>,
    name: String,
) -> usize {
    if let Some(index) = companies
        .iter()
        .position(|company| company.legal_entity_id == legal_entity_id && company.company == name)
    {
        return index;
    }
    companies.push(HrOrgChartCompany {
        legal_entity_id,
        company: name,
        total: 0,
        active: 0,
        units: vec![],
    });
    companies.len() - 1
}

pub fn find_or_insert_unit(
    units: &mut Vec<HrOrgChartUnit>,
    org_unit_id: Option<Uuid>,
    name: String,
) -> usize {
    if let Some(index) = units
        .iter()
        .position(|unit| unit.org_unit_id == org_unit_id && unit.name == name)
    {
        return index;
    }
    units.push(HrOrgChartUnit {
        org_unit_id,
        name,
        total: 0,
        positions: vec![],
    });
    units.len() - 1
}

pub fn find_or_insert_position(positions: &mut Vec<HrOrgChartPosition>, title: String) -> usize {
    if let Some(index) = positions
        .iter()
        .position(|position| position.title == title)
    {
        return index;
    }
    positions.push(HrOrgChartPosition {
        title,
        total: 0,
        employees: vec![],
    });
    positions.len() - 1
}

impl HrService {
    pub async fn org_chart(&self, principal: Principal) -> Result<HrOrgChartResponse, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
        record_hr_read("org_chart");
        let org = principal.org_id;
        let reader = principal.clone();

        let companies = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
        Box::pin(async move {
            let rows = sqlx::query(concat!(
                r#"
                SELECT
                    e.id,
                    ea.legal_entity_id,
                    COALESCE(le.label, e.company) AS company,
                    e.name,
                    e.employee_number,
                    e.org_unit_id,
                    -- Bound rows group by the real unit under its CURRENT name
                    -- (a rename shows immediately); unbound rows keep the
                    -- legacy free-text grouping.
                    COALESCE(
                        NULLIF(unit.attributes->>'name', ''),
                        NULLIF(e.org_unit, ''),
                        '소속 미지정'
                    ) AS org_unit,
                    COALESCE(NULLIF(e.position, ''), '직책 미지정') AS position,
                    entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status
                FROM person_employees_current e
                LEFT JOIN LATERAL (
                    SELECT r.attributes FROM org_unit_revisions r
                    WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
                    ORDER BY r.version DESC LIMIT 1
                ) unit ON e.org_unit_id IS NOT NULL
                "#,
                assignment_lateral!(),
                r#"
                LEFT JOIN LATERAL (
                    SELECT x.name AS label
                    FROM legal_entity_revisions x
                    WHERE x.org_id = e.org_id AND x.legal_entity_id = ea.legal_entity_id
                      AND x.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date
                    ORDER BY x.effective_from DESC, x.version DESC LIMIT 1
                ) le ON ea.legal_entity_id IS NOT NULL
                WHERE entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status)
                ORDER BY 3 ASC, 2 ASC NULLS LAST, 7 ASC, 8 ASC, e.name ASC, e.source_sheet ASC, e.source_row ASC
                LIMIT 5000
                "#
            ))
            .fetch_all(tx.as_mut())
            .await?;

            let mut companies = Vec::<HrOrgChartCompany>::new();
            let row_count = rows.len();
            for row in rows {
                let company: String = row.try_get("company")?;
                let unit: String = row.try_get("org_unit")?;
                let position: String = row.try_get("position")?;
                let status: String = row.try_get("employment_status")?;

                let company_index = find_or_insert_company(
                    &mut companies,
                    row.try_get("legal_entity_id")?,
                    company,
                );
                let company = &mut companies[company_index];
                company.total += 1;
                if status == "ACTIVE" {
                    company.active += 1;
                }

                let unit_index =
                    find_or_insert_unit(&mut company.units, row.try_get("org_unit_id")?, unit);
                let unit = &mut company.units[unit_index];
                unit.total += 1;

                let position_index = find_or_insert_position(&mut unit.positions, position);
                let position = &mut unit.positions[position_index];
                position.total += 1;
                position.employees.push(HrOrgChartEmployee {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    employee_number: row.try_get("employee_number")?,
                    status,
                });
            }
            // Like the export, the whole-population chart names its row
            // count, not every subject id (up to 5000).
            let me = actor_employee_id(tx, &reader).await?;
            let details = json!({ "row_count": row_count });
            let event = access_event(&reader, DirectoryAccess::OrgChart, &[], me, details)?;
            Ok((companies, vec![event]))
        })
    })
    .await?;

        Ok(HrOrgChartResponse { companies })
    }
}
