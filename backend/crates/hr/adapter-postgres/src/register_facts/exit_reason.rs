//! Where an employee's exit reason lives: on their live exit case when the
//! report gave one (the case owns it), else on the register item recorded for
//! an exit without a case, or without a reason on its case.

/// SQL for the effective exit reason code of the employee row aliased `e`.
macro_rules! exit_reason_code_sql {
    () => {
        "COALESCE((SELECT c.exit_reason_code FROM employee_exit_cases c \
           WHERE c.org_id = e.org_id AND c.employee_id = e.id \
             AND c.status NOT IN ('REJECTED', 'CANCELLED') AND c.exit_reason_code IS NOT NULL \
           ORDER BY c.reported_at DESC LIMIT 1), \
         (SELECT f.exit_reason_code FROM employee_register_facts f \
           WHERE f.org_id = e.org_id AND f.employee_id = e.id))"
    };
}
pub(crate) use exit_reason_code_sql;
