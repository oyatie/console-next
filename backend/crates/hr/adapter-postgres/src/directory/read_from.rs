//! The one FROM behind every `GET /employees` read and its leaner forms for
//! counts and facets (split from `read_filters.rs`, PERF-BE).

use sqlx::{Postgres, QueryBuilder};

use crate::directory::read_filters::EmployeeListFilters;

/// `fe`: the employee's latest APPLY_FAILED lifecycle event not yet redone —
/// no SCHEDULED or APPLIED event of the same kind was recorded after it —
/// while the employee has not exited.
#[macro_export]
macro_rules! failed_event_lateral {
    () => {
        " LEFT JOIN LATERAL (SELECT f.id, f.event_type, f.effective_date, f.failure_code \
           FROM employee_lifecycle_events f \
           WHERE f.org_id = e.org_id AND f.employee_id = e.id AND f.state = 'APPLY_FAILED' \
             AND e.employment_status <> 'EXITED' \
             AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events r \
               WHERE r.org_id = f.org_id AND r.employee_id = f.employee_id \
                 AND r.event_type = f.event_type AND r.state IN ('SCHEDULED', 'APPLIED') \
                 AND r.created_at > f.created_at) \
           ORDER BY f.effective_date DESC, f.created_at DESC LIMIT 1) fe ON TRUE "
    };
}

/// `lr`: while the employee is ON_LEAVE, the expected return date of the
/// latest applied LEAVE_OF_ABSENCE (null when it named none).
#[macro_export]
macro_rules! leave_return_lateral {
    () => {
        " LEFT JOIN LATERAL (SELECT l.expected_return_date::TEXT AS expected_return_date \
           FROM employee_lifecycle_events l \
           WHERE l.org_id = e.org_id AND l.employee_id = e.id \
             AND l.event_type = 'LEAVE_OF_ABSENCE' AND l.state = 'APPLIED' \
             AND e.employment_status = 'ON_LEAVE' \
           ORDER BY l.effective_date DESC, l.created_at DESC LIMIT 1) lr ON TRUE "
    };
}

/// `ss`: when the current status began; stored exit dates are the last working day.
#[macro_export]
macro_rules! status_since_lateral {
    () => {
        " LEFT JOIN LATERAL (SELECT CASE WHEN entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) = 'EXITED' \
             THEN entity_retirement_on(entity_try_iso_date(COALESCE(opened.effective_date,e.exit_date)))::TEXT \
             ELSE COALESCE(opened.effective_date,e.hire_date) END AS status_since \
           FROM (SELECT (SELECT l.effective_date FROM employee_lifecycle_events l \
             WHERE l.org_id = e.org_id AND l.employee_id = e.id AND l.state = 'APPLIED' \
               AND l.event_type <> 'RESCIND' AND l.to_status = entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) \
               AND l.from_status IS DISTINCT FROM l.to_status \
               AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
                 WHERE v.org_id = l.org_id AND v.employee_id = l.employee_id \
                   AND v.voids_event_id = l.id AND v.state NOT IN ('CANCELLED','APPLY_FAILED')) \
             ORDER BY l.effective_date DESC,l.created_at DESC,l.id DESC LIMIT 1) AS effective_date) opened) ss ON TRUE "
    };
}

/// `ea`: the employee's 법인 / 사업장 by id (E-S3a): the live assignment
/// covering today (KST), else the last one before it (an exited employee), else
/// the first future one (a pre-hire). Superseded rows never count.
#[macro_export]
macro_rules! assignment_lateral {
    () => {
        " LEFT JOIN employment_resolved_assignments ea ON ea.org_id=e.org_id AND ea.employee_id=e.id "
    };
}

/// The one current or first pre-hire placement set, shared with facets, inbox and the unplaced queue.
#[macro_export]
macro_rules! current_placement_join {
    () => {
        " LEFT JOIN employment_current_placements cp ON cp.org_id=e.org_id AND cp.employee_id=e.id "
    };
}
const PROFILE_JOIN: &str = " LEFT JOIN employee_employment_profiles p \
     ON p.employee_id = e.id AND p.org_id = e.org_id";

/// `fe` as a set (CAP-01): the employees with an APPLY_FAILED event not yet
/// redone, while not exited — the rows [`failed_event_lateral`] finds one
/// for, without probing every employee. For counts: it carries no event.
const FAILED_SET_JOIN: &str = " LEFT JOIN (SELECT DISTINCT f.org_id, f.employee_id AS id \
       FROM employee_lifecycle_events f \
       WHERE f.state = 'APPLY_FAILED' \
         AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events r \
           WHERE r.org_id = f.org_id AND r.employee_id = f.employee_id \
             AND r.event_type = f.event_type AND r.state IN ('SCHEDULED', 'APPLIED') \
             AND r.created_at > f.created_at)) fe \
     ON fe.org_id = e.org_id AND fe.id = e.id AND e.employment_status <> 'EXITED'";

const FILTERED_FROM: &str = concat!(
    " FROM person_employees_current e \
     LEFT JOIN branches b ON b.id = e.home_branch_id \
       AND b.org_id = e.org_id AND b.deactivated_at IS NULL \
     LEFT JOIN employee_employment_profiles p \
       ON p.employee_id = e.id AND p.org_id = e.org_id \
     LEFT JOIN LATERAL (SELECT n.id, n.event_type, n.effective_date \
       FROM employee_lifecycle_events n \
       WHERE n.org_id = e.org_id AND n.employee_id = e.id AND n.state = 'SCHEDULED' \
       ORDER BY n.effective_date, n.created_at LIMIT 1) ne ON TRUE",
    failed_event_lateral!(),
    leave_return_lateral!(),
    status_since_lateral!(),
    assignment_lateral!(),
    current_placement_join!(),
    " WHERE TRUE"
);

/// `<select>` over the employees the list filters admit. The one FROM/WHERE
/// behind the list page, its total, the facet counts and the export, so a
/// scope or filter added here applies to every one of them.
pub fn filtered_employees(select: &str, filters: &EmployeeListFilters) -> QueryBuilder<Postgres> {
    let mut builder = QueryBuilder::<Postgres>::new(select);
    push_filtered_from(&mut builder, filters);
    builder
}

/// The FROM/WHERE of [`filtered_employees`], for a select that binds values.
pub fn push_filtered_from(builder: &mut QueryBuilder<Postgres>, filters: &EmployeeListFilters) {
    builder.push(FILTERED_FROM);
    filters.push(builder);
}

/// `<select>` over the same rows as [`filtered_employees`], joining only what
/// the active filters read (CAP-01: the page total and a selection's ids no
/// longer run four per-row LATERALs they never read). For a select of `e.*`
/// columns only. Every join is at most one row per employee, so the rows are
/// the same.
pub fn counted_employees(select: &str, filters: &EmployeeListFilters) -> QueryBuilder<Postgres> {
    let mut builder = QueryBuilder::<Postgres>::new(select);
    builder.push(" FROM person_employees_current e");
    if filters.home_branch_review_required.is_some() {
        builder.push(current_placement_join!());
    }
    if filters.contract_ending_before.is_some() || filters.register_review_required.is_some() {
        builder.push(PROFILE_JOIN);
    }
    if filters.lifecycle_apply_failed.is_some() {
        builder.push(FAILED_SET_JOIN);
    }
    if filters.legal_entity_id.is_some()
        || filters.workplace_id.is_some()
        || filters.reach_reads_assignment()
    {
        builder.push(assignment_lateral!());
    }
    builder.push(" WHERE TRUE");
    filters.push(&mut builder);
    builder
}

/// The FROM/WHERE of the one-pass facets: every join a facet group reads
/// (`b`, `p`, the `fe` set, `ea`) and only the filters no group lifts.
pub fn push_facets_from(builder: &mut QueryBuilder<Postgres>, filters: &EmployeeListFilters) {
    builder.push(" FROM person_employees_current e");
    builder.push(current_placement_join!());
    builder.push(PROFILE_JOIN);
    builder.push(FAILED_SET_JOIN);
    builder.push(assignment_lateral!());
    builder.push(" WHERE TRUE");
    filters.push_base(builder);
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::directory::read_filters::EmployeeListQuery;
    use console_kernel_core::BranchScope;

    fn filters(query: serde_json::Value) -> EmployeeListFilters {
        let query: EmployeeListQuery = serde_json::from_value(query).unwrap();
        EmployeeListFilters::from_query(&query, &BranchScope::All).unwrap()
    }

    /// regression (CAP-01): the page total ran the list's four per-row
    /// LATERALs for every employee (274,807 buffers, 2.7 s at 30,000 rows).
    #[test]
    fn regression_the_plain_total_joins_nothing() {
        let sql = counted_employees("SELECT count(*)", &filters(serde_json::json!({})))
            .into_sql()
            .as_str()
            .to_owned();
        assert!(!sql.contains("JOIN"), "{sql}");
        let sql = counted_employees(
            "SELECT count(*)",
            &filters(serde_json::json!({ "lifecycle_apply_failed": true, "status": "ACTIVE" })),
        )
        .into_sql()
        .as_str()
        .to_owned();
        assert!(!sql.contains("LATERAL"), "{sql}");
        assert!(sql.contains(") fe"), "{sql}");
    }
}
