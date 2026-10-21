//! Existing persona refusal assertions, shared unchanged by their original tests.
use super::{Response, StatusCode, Uuid};

pub(super) fn assert_forbidden(response: &Response) {
    assert_eq!(
        response.status,
        StatusCode::FORBIDDEN,
        "{:?}",
        response.json
    );
    assert_eq!(response.json["error"]["code"], "forbidden");
    assert_no_employee_or_payroll_figures(response);
}

pub(super) fn assert_not_found(response: &Response) {
    assert_eq!(
        response.status,
        StatusCode::NOT_FOUND,
        "{:?}",
        response.json
    );
    assert_eq!(response.json["error"]["code"], "not_found");
    assert_no_employee_or_payroll_figures(response);
}

pub(super) fn assert_omits_exception(response: &Response, exception_id: Uuid) {
    let body = response.json.to_string();
    assert!(
        !body.contains(&exception_id.to_string()),
        "omit body leaked exception id: {body}"
    );
    assert_no_employee_or_payroll_figures(response);
}

pub(super) fn assert_no_employee_or_payroll_figures(response: &Response) {
    let body = response.json.to_string();
    let lower = body.to_ascii_lowercase();
    for needle in [
        "employee_id",
        "employeeid",
        "employee_name",
        "employeename",
        "employee_number",
        "persona-employee",
        "ot_hours",
        "othours",
        "base_pay",
        "basepay",
        "payroll",
        "period_lock",
        "worker_rate",
    ] {
        assert!(
            !lower.contains(needle),
            "error body leaked {needle}: {body}"
        );
    }
}
