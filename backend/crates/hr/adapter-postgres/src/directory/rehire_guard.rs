// SPDX-License-Identifier: LicenseRef-Proprietary
//! Rehire waits for the prior decision, then acknowledges the settlement still owed.
use crate::HrError;
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct RehireExitCase {
    pub case_id: Uuid,
    pub status: String,
    pub decision_final: bool,
    pub acknowledgement_required: bool,
    pub open_legs: Vec<&'static str>,
}
pub(crate) async fn latest(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<RehireExitCase>, HrError> {
    let row: Option<(Uuid,String,Option<String>)> = sqlx::query_as("SELECT c.id,c.status,p.status FROM employee_exit_cases c LEFT JOIN employee_exit_settlement_packages p ON p.org_id=c.org_id AND p.exit_case_id=c.id WHERE c.org_id=$1 AND c.employee_id=$2 ORDER BY c.reported_at DESC,c.id DESC LIMIT 1")
        .bind(org).bind(employee).fetch_optional(conn).await?;
    Ok(row.map(|(case_id, status, settlement)| {
        let decision_final = !matches!(status.as_str(), "REPORTED" | "HR_CONFIRMED");
        let acknowledgement_required = !matches!(
            status.as_str(),
            "REPORTED" | "HR_CONFIRMED" | "REJECTED" | "CANCELLED"
        );
        let mut open_legs = Vec::new();
        if !decision_final {
            open_legs.push("hq_confirmation");
        }
        if acknowledgement_required && settlement.as_deref() != Some("SUBMITTED") {
            open_legs.push("settlement");
        }
        if acknowledgement_required {
            open_legs.push("settlement_completion_unconfirmed");
        }
        RehireExitCase {
            case_id,
            status,
            decision_final,
            acknowledgement_required,
            open_legs,
        }
    }))
}
pub(crate) async fn check(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    acknowledge: bool,
) -> Result<(), HrError> {
    if let Some(case) = latest(conn, org, employee).await?
        && (!case.decision_final || (case.acknowledgement_required && !acknowledge))
    {
        return Err(HrError { status:http::StatusCode::CONFLICT,code:"rehire_exit_case_open",
            message:"the prior exit decision or its remaining settlement must be resolved or acknowledged".into(),
            errors:None,refusals:Some(Box::new(json!([case]))) });
    }
    Ok(())
}
