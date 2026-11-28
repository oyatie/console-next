// SPDX-License-Identifier: LicenseRef-Proprietary
use super::read_filters::{DEPARTMENT_MISSING, EmployeeListFilters, FacetGroup};
use sqlx::{Postgres, QueryBuilder};

impl EmployeeListFilters {
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
                if let Some(required) = self.team_review_required {
                    and(
                        builder,
                        concat!(
                            "(",
                            crate::register_review_sql!(),
                            " OR ",
                            crate::identity_review_sql!(),
                            " OR p.employment_type IS NULL)"
                        ),
                    );
                    builder.push(" = ").push_bind(required);
                }
                if let Some(from) = self.contract_ending_on_or_after {
                    and(builder, "p.contract_end_date >= ");
                    builder.push_bind(from);
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
