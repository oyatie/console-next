//! The `GET /employees` filters and the one FROM/WHERE they apply to, shared
//! by the list page, its total, the facet counts and the export (PEOPLE-B).

use console_hr_domain::text::{normalize_enum_text, parse_yyyy_mm_dd};
use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal, cedar_pbac::visible::EmployeeVisibility};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder};
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::authz::HrReach;
pub(crate) use crate::directory::read_visibility::{FacetGroup, push_within, visibility};

pub use crate::directory::read_from::{
    counted_employees, filtered_employees, push_facets_from, push_filtered_from,
};

/// The most employee numbers one list read resolves (the bulk-action cap).
pub const MAX_EMPLOYEE_NUMBERS: usize = 500;

pub(crate) const DEPARTMENT_MISSING: &str = "(e.merged_into_employee_id IS NULL AND entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AND (e.org_unit_id IS NULL OR e.org_unit_id NOT IN (SELECT department_unit_ids())) AND e.id NOT IN (SELECT supervised_without_department_employee_ids()))";

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct EmployeeListQuery {
    pub company: Option<String>,
    pub search: Option<String>,
    /// Deprecated compatibility name: true means no current workplace placement.
    pub home_branch_review_required: Option<bool>,
    pub identity_review_required: Option<bool>,
    pub register_review_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_review_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_ending_on_or_after: Option<String>,
    // Preserve N-1 bulk-selection fingerprints when this filter is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department_missing: Option<bool>,
    pub org_unit_id: Option<Uuid>,
    /// Legal entity by id: employees whose current (or, once exited, last)
    /// employment assignment names it (E-S3a).
    pub legal_entity_id: Option<Uuid>,
    /// Workplace by id, on the same assignment as `legal_entity_id`.
    pub workplace_id: Option<Uuid>,
    /// One status or a comma-separated list (`status=ACTIVE,ON_LEAVE`).
    pub status: Option<String>,
    /// Exact employee numbers, comma-separated (`employee_number=A-1,A-2`),
    /// at most [`MAX_EMPLOYEE_NUMBERS`]: resolves a pasted column in one read.
    pub employee_number: Option<String>,
    /// Exact employee IDs, comma-separated (`ids=<uuid>,<uuid>`), at most
    /// [`MAX_EMPLOYEE_NUMBERS`]: resolves a selected set without full-roster scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<String>,
    /// `YYYY-MM-DD`: only employees whose current contract ends strictly
    /// before this date (an expired contract, for a date of tomorrow).
    pub contract_ending_before: Option<String>,
    /// `true`: only employees with an unresolved scheduled action that could
    /// not apply on its date (`failed_event` set).
    pub lifecycle_apply_failed: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// Keyset paging (A1): `name`, `employee_number`, `hire_date` or
    /// `org_unit`, `-` for descending. Without it the list keeps its offset
    /// order.
    pub sort: Option<String>,
    /// The previous page's `next_cursor`; it carries its sort.
    pub cursor: Option<String>,
}

/// The validated `GET /employees` filters, applied identically to the count
/// and the page query.
#[derive(Clone)]
pub struct EmployeeListFilters {
    pub company: Option<String>,
    pub search: Option<String>,
    /// Deprecated compatibility name: true means no current workplace placement.
    pub home_branch_review_required: Option<bool>,
    pub identity_review_required: Option<bool>,
    pub register_review_required: Option<bool>,
    pub team_review_required: Option<bool>,
    pub contract_ending_on_or_after: Option<Date>,
    pub department_missing: Option<bool>,
    pub org_unit_id: Option<Uuid>,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub statuses: Vec<String>,
    pub employee_numbers: Vec<String>,
    pub ids: Vec<Uuid>,
    pub contract_ending_before: Option<Date>,
    pub lifecycle_apply_failed: Option<bool>,
    /// Who the reader may see (AX-5: the grant set; a legacy branch role, the
    /// people homed in its branches), in every read built on these filters.
    pub reach: HrReach,
    visibility: Option<EmployeeVisibility>,
    /// A second reach every row is also within: the edit reach, for a read
    /// that carries columns only an editor sees.
    edit: Option<(HrReach, Option<EmployeeVisibility>)>,
}

impl EmployeeListFilters {
    pub fn from_query(query: &EmployeeListQuery, scope: &BranchScope) -> Result<Self, HrError> {
        Self::from_query_for_reach(query, HrReach::from(scope))
    }

    pub fn from_query_for_reach(
        query: &EmployeeListQuery,
        reach: HrReach,
    ) -> Result<Self, HrError> {
        let trimmed = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let statuses = trimmed(&query.status)
            .map(|raw| {
                raw.split(',')
                    .map(|part| normalize_enum_text(part.to_owned()))
                    .filter(|part| !part.is_empty())
                    .map(|part| {
                        // BW-19: pending hire (PRE_HIRE) is listable; the refusal text is
                        // frozen (error_i18n matches it), so it does not name it.
                        if matches!(
                            part.as_str(),
                            "PRE_HIRE" | "ACTIVE" | "ON_LEAVE" | "EXITED" | "UNKNOWN"
                        ) {
                            Ok(part)
                        } else {
                            Err(HrError::validation(
                                "status must be ACTIVE, ON_LEAVE, EXITED, or UNKNOWN",
                            ))
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        let employee_numbers: Vec<String> = trimmed(&query.employee_number)
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if employee_numbers.len() > MAX_EMPLOYEE_NUMBERS {
            return Err(HrError::validation(
                "employee_number accepts at most 500 values",
            ));
        }
        let ids: Vec<Uuid> = trimmed(&query.ids)
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(|part| {
                        Uuid::parse_str(part)
                            .map_err(|_| HrError::validation("ids must contain valid UUIDs"))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        if ids.len() > MAX_EMPLOYEE_NUMBERS {
            return Err(HrError::validation("ids accepts at most 500 values"));
        }
        Ok(Self {
            company: trimmed(&query.company),
            search: trimmed(&query.search),
            home_branch_review_required: query.home_branch_review_required,
            identity_review_required: query.identity_review_required,
            register_review_required: query.register_review_required,
            team_review_required: query.team_review_required,
            contract_ending_on_or_after: trimmed(&query.contract_ending_on_or_after)
                .map(|s| parse_yyyy_mm_dd(&s))
                .transpose()?,
            department_missing: query.department_missing,
            org_unit_id: query.org_unit_id,
            legal_entity_id: query.legal_entity_id,
            workplace_id: query.workplace_id,
            statuses,
            employee_numbers,
            ids,
            contract_ending_before: trimmed(&query.contract_ending_before)
                .map(|raw| parse_yyyy_mm_dd(&raw))
                .transpose()?,
            lifecycle_apply_failed: query.lifecycle_apply_failed,
            reach,
            visibility: None,
            edit: None,
        })
    }

    /// The reader's reach from the grant set (AX-5), replacing the branch scope.
    #[must_use]
    pub fn with_reach(mut self, reach: HrReach) -> Self {
        self.reach = reach;
        self
    }

    /// Rows also within `reach` of `employee_directory_manage`.
    #[must_use]
    pub fn within_edit(mut self, reach: HrReach) -> Self {
        self.edit = Some((reach, None));
        self
    }

    /// Scoped readers use the same Cedar node as Home and exit commands.
    pub(crate) async fn load_visibility(
        &mut self,
        tx: &mut sqlx::Transaction<'_, Postgres>,
        principal: &Principal,
        feature: Feature,
    ) -> Result<(), HrError> {
        self.visibility = visibility(tx, principal, feature).await?;
        if let Some((_, edit)) = &mut self.edit {
            *edit = visibility(tx, principal, Feature::EmployeeDirectoryManage).await?;
        }
        Ok(())
    }

    /// Whether the reach reads the `ea` assignment.
    pub fn reach_reads_assignment(&self) -> bool {
        let reads = |reach: &HrReach, visibility: &Option<EmployeeVisibility>| {
            visibility
                .as_ref()
                .is_some_and(EmployeeVisibility::reads_assignment)
                || matches!(reach, HrReach::Within { scope, .. } if !scope.is_empty())
        };
        reads(&self.reach, &self.visibility)
            || self
                .edit
                .as_ref()
                .is_some_and(|(reach, visibility)| reads(reach, visibility))
    }

    /// Appends ` AND …` clauses; the builder's query must alias `employees e`,
    /// `branches b` (home branch), `employee_employment_profiles p`, the
    /// [`failed_event_lateral`] `fe` and the [`assignment_lateral`] `ea`.
    pub fn push(&self, builder: &mut QueryBuilder<Postgres>) {
        self.push_base(builder);
        for group in FacetGroup::ALL {
            builder.push(" AND ");
            self.push_group(group, builder);
        }
    }

    /// ` AND …` for the filters no facet group lifts: the branch scope,
    /// company, search, organization and employee number (every read applies
    /// them).
    pub(crate) fn push_base(&self, builder: &mut QueryBuilder<Postgres>) {
        builder.push(" AND ");
        push_within(builder, &self.reach, &self.visibility);
        if let Some((reach, visibility)) = &self.edit {
            builder.push(" AND ");
            push_within(builder, reach, visibility);
        }
        if let Some(company) = self.company.as_deref() {
            builder.push(" AND e.company = ");
            builder.push_bind(company.to_owned());
        }
        if let Some(search) = self.search.as_deref() {
            let pattern = format!("%{}%", crate::scope_sql::escape_like(search));
            builder.push(" AND (COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) ILIKE ");
            builder.push_bind(pattern.clone());
            builder.push(" ESCAPE '\\' OR e.employee_number ILIKE ");
            builder.push_bind(pattern);
            builder.push(" ESCAPE '\\')");
        }
        if let Some(org_unit_id) = self.org_unit_id {
            // The org-unit preview also includes legacy UUID-text placements.
            builder.push(" AND (e.org_unit_id = ");
            builder.push_bind(org_unit_id);
            builder.push(" OR e.org_unit = ");
            builder.push_bind(org_unit_id);
            builder.push("::text)");
        }
        if !self.employee_numbers.is_empty() {
            builder.push(" AND e.employee_number = ANY(");
            builder.push_bind(self.employee_numbers.clone());
            builder.push(")");
        }
        if !self.ids.is_empty() {
            builder.push(" AND e.id = ANY(");
            builder.push_bind(self.ids.clone());
            builder.push(")");
        }
    }
}
