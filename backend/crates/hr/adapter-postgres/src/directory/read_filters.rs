//! The `GET /employees` filters and the one FROM/WHERE they apply to, shared
//! by the list page, its total, the facet counts and the export (PEOPLE-B).

use console_hr_domain::text::{normalize_enum_text, parse_yyyy_mm_dd};
use console_kernel_core::BranchScope;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder};
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::authz::{HrReach, push_reach};

pub use crate::directory::read_from::{
    counted_employees, filtered_employees, push_facets_from, push_filtered_from,
};

/// The most employee numbers one list read resolves (the bulk-action cap).
pub const MAX_EMPLOYEE_NUMBERS: usize = 500;

pub(crate) const DEPARTMENT_MISSING: &str = "(e.merged_into_employee_id IS NULL AND entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AND (e.org_unit_id IS NULL OR e.org_unit_id NOT IN (SELECT department_unit_ids())))";

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct EmployeeListQuery {
    pub company: Option<String>,
    pub search: Option<String>,
    /// Deprecated compatibility name: true means no current workplace placement.
    pub home_branch_review_required: Option<bool>,
    pub identity_review_required: Option<bool>,
    pub register_review_required: Option<bool>,
    // Preserve N-1 bulk-selection fingerprints when this filter is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department_missing: Option<bool>,
    pub org_unit_id: Option<Uuid>,
    /// 법인 by id: employees whose current (or, once exited, last) employment
    /// assignment names it (E-S3a).
    pub legal_entity_id: Option<Uuid>,
    /// 사업장 by id, on the same assignment as `legal_entity_id`.
    pub workplace_id: Option<Uuid>,
    /// One status or a comma-separated list (`status=ACTIVE,ON_LEAVE`).
    pub status: Option<String>,
    /// Exact employee numbers, comma-separated (`employee_number=A-1,A-2`),
    /// at most [`MAX_EMPLOYEE_NUMBERS`]: resolves a pasted column in one read.
    pub employee_number: Option<String>,
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
    pub department_missing: Option<bool>,
    pub org_unit_id: Option<Uuid>,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub statuses: Vec<String>,
    pub employee_numbers: Vec<String>,
    pub contract_ending_before: Option<Date>,
    pub lifecycle_apply_failed: Option<bool>,
    /// Who the reader may see (AX-5: the grant set; a legacy branch role, the
    /// people homed in its branches), in every read built on these filters.
    pub reach: HrReach,
}

impl EmployeeListFilters {
    pub fn from_query(query: &EmployeeListQuery, scope: &BranchScope) -> Result<Self, HrError> {
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
                        // BW-19: 입사 예정 (PRE_HIRE) is listable; the refusal text is
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
        Ok(Self {
            company: trimmed(&query.company),
            search: trimmed(&query.search),
            home_branch_review_required: query.home_branch_review_required,
            identity_review_required: query.identity_review_required,
            register_review_required: query.register_review_required,
            department_missing: query.department_missing,
            org_unit_id: query.org_unit_id,
            legal_entity_id: query.legal_entity_id,
            workplace_id: query.workplace_id,
            statuses,
            employee_numbers,
            contract_ending_before: trimmed(&query.contract_ending_before)
                .map(|raw| parse_yyyy_mm_dd(&raw))
                .transpose()?,
            lifecycle_apply_failed: query.lifecycle_apply_failed,
            reach: HrReach::from(scope),
        })
    }

    /// The reader's reach from the grant set (AX-5), replacing the branch scope.
    #[must_use]
    pub fn with_reach(mut self, reach: HrReach) -> Self {
        self.reach = reach;
        self
    }

    /// Whether the reach reads the `ea` assignment.
    pub fn reach_reads_assignment(&self) -> bool {
        matches!(&self.reach, HrReach::Within { scope, .. } if !scope.is_empty())
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
    /// company, search, 조직 and 사번 (every read applies them).
    pub(crate) fn push_base(&self, builder: &mut QueryBuilder<Postgres>) {
        builder.push(" AND ");
        push_reach(builder, &self.reach);
        if let Some(company) = self.company.as_deref() {
            builder.push(" AND e.company = ");
            builder.push_bind(company.to_owned());
        }
        if let Some(search) = self.search.as_deref() {
            builder.push(" AND (COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) ILIKE ");
            builder.push_bind(format!("%{search}%"));
            builder.push(" OR e.employee_number ILIKE ");
            builder.push_bind(format!("%{search}%"));
            builder.push(")");
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
    }

    /// One facet group's filters as a boolean expression (`TRUE` when none
    /// is set), so the facets can count each group without its own filter
    /// in one scan.
    pub(crate) fn push_group(&self, group: FacetGroup, builder: &mut QueryBuilder<Postgres>) {
        let mut terms = 0;
        let mut and = |builder: &mut QueryBuilder<Postgres>, sql: &str| {
            builder.push(if terms == 0 { "(" } else { " AND " });
            builder.push(sql);
            terms += 1;
        };
        match group {
            FacetGroup::Status => {
                if !self.statuses.is_empty() {
                    and(
                        builder,
                        "entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) = ANY(",
                    );
                    builder.push_bind(self.statuses.clone());
                    builder.push(")");
                }
            }
            FacetGroup::LegalEntity => {
                if let Some(legal_entity_id) = self.legal_entity_id {
                    and(builder, "ea.legal_entity_id = ");
                    builder.push_bind(legal_entity_id);
                }
            }
            FacetGroup::Workplace => {
                if let Some(workplace_id) = self.workplace_id {
                    and(builder, "ea.workplace_id = ");
                    builder.push_bind(workplace_id);
                }
            }
            FacetGroup::Review => {
                if let Some(required) = self.department_missing {
                    and(builder, DEPARTMENT_MISSING);
                    builder.push(" = ");
                    builder.push_bind(required);
                }
                if let Some(required) = self.register_review_required {
                    and(builder, crate::register_review_sql!());
                    builder.push(" = ");
                    builder.push_bind(required);
                }
                if let Some(required) = self.home_branch_review_required {
                    and(builder, "(cp.employee_id IS NULL) = ");
                    builder.push_bind(required);
                }
                if let Some(required) = self.identity_review_required {
                    and(builder, crate::identity_review_sql!());
                    builder.push(" = ");
                    builder.push_bind(required);
                }
                if let Some(before) = self.contract_ending_before {
                    and(builder, "p.contract_end_date < ");
                    builder.push_bind(before);
                }
                if let Some(failed) = self.lifecycle_apply_failed {
                    and(builder, "(fe.id IS NOT NULL) = ");
                    builder.push_bind(failed);
                }
            }
        }
        builder.push(if terms == 0 { "TRUE" } else { ")" });
    }
}

/// The filter groups a facet chip lifts: each group is counted with every
/// filter except its own (`read_facets`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FacetGroup {
    Status,
    LegalEntity,
    Workplace,
    /// 확인 필요 flags and the contract window.
    Review,
}

impl FacetGroup {
    const ALL: [Self; 4] = [
        Self::Status,
        Self::LegalEntity,
        Self::Workplace,
        Self::Review,
    ];
}
