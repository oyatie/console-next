use crate::HrError;
use console_hr_domain::contract::ContractRow;
use http::StatusCode;
use serde_json::json;

pub(super) fn overlap(other: &ContractRow) -> HrError {
    HrError {
        status: StatusCode::CONFLICT,
        code: "contract_overlap",
        message: "the contract period overlaps an existing contract; correct that contract instead"
            .into(),
        refusals: Some(json!([{
            "contract_id": other.id,
            "kind": other.terms.kind,
            "start_date": other.terms.start_date.to_string(),
            "end_date": other.terms.end_date.map(|date| date.to_string()),
        }])),
    }
}
