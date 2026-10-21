//! BW-30 read API over the statutory register.
//!
//! The register is public law, identical for every tenant and carrying no
//! tenant or personal data, so the only gate is an authenticated principal
//! (401 without one). There is no "who may" rule to put in Cedar.

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use console_compliance_domain::statutory::{
    InsuranceLossCode, Insurer, LossReasonGroup, ReleaseDisposition,
};
use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;
use time::macros::format_description;

use super::{ComplianceRestState, RestError, principal_from_headers};

pub const STATUTORY_ROUTE_PATHS: &[&str] = &["/api/v1/statutory/insurance-loss-codes"];

pub(super) fn routes() -> Router<ComplianceRestState> {
    Router::new().route(
        "/api/v1/statutory/insurance-loss-codes",
        get(list_insurance_loss_codes),
    )
}

#[derive(Debug, Deserialize)]
struct LossCodeQuery {
    insurer: Option<String>,
    on: Option<String>,
}

#[derive(Debug, Serialize)]
struct LossCodePage {
    items: Vec<LossCodeDto>,
}

#[derive(Debug, Serialize)]
struct LossCodeDto {
    insurer: Insurer,
    code: String,
    label_ko: String,
    reason_group: LossReasonGroup,
    requires_detail: bool,
    /// The code-table version an exit payload records.
    effective_from: String,
    effective_to_exclusive: Option<String>,
    instrument_ko: String,
    article_ko: String,
    source_url: String,
    release_disposition: &'static str,
    review_receipt_ref: Option<String>,
}

impl From<&InsuranceLossCode> for LossCodeDto {
    fn from(code: &InsuranceLossCode) -> Self {
        let (release_disposition, review_receipt_ref) = match &code.disposition {
            ReleaseDisposition::Hold => ("HOLD", None),
            ReleaseDisposition::Released { receipt_ref } => ("RELEASED", Some(receipt_ref.clone())),
        };
        Self {
            insurer: code.insurer,
            code: code.code.clone(),
            label_ko: code.label_ko.clone(),
            reason_group: code.group,
            requires_detail: code.requires_detail,
            effective_from: code.effective_from.to_string(),
            effective_to_exclusive: code.effective_to_exclusive.map(|d| d.to_string()),
            instrument_ko: code.citation.instrument_ko.clone(),
            article_ko: code.citation.article_ko.clone(),
            source_url: code.citation.source_url.clone(),
            release_disposition,
            review_receipt_ref,
        }
    }
}

fn parse_query(query: &LossCodeQuery) -> Result<(Insurer, Date), KernelError> {
    let insurer = query
        .insurer
        .as_deref()
        .ok_or_else(|| KernelError::validation("insurer is required").with_field("insurer"))
        .and_then(|value| Insurer::from_db_str(value).map_err(|e| e.with_field("insurer")))?;
    let on = query
        .on
        .as_deref()
        .ok_or_else(|| KernelError::validation("on is required").with_field("on"))
        .and_then(|value| {
            Date::parse(value, format_description!("[year]-[month]-[day]")).map_err(|_| {
                KernelError::validation("on must be a YYYY-MM-DD date").with_field("on")
            })
        })?;
    Ok((insurer, on))
}

/// The `insurer`'s 상실 codes in force on `on`. HOLD rows are listed with their
/// disposition; an insurer with no sourced table returns an empty list.
async fn list_insurance_loss_codes(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
    Query(query): Query<LossCodeQuery>,
) -> Result<Json<LossCodePage>, RestError> {
    principal_from_headers(&state, &headers).await?;
    let (insurer, on) = parse_query(&query).map_err(RestError::from_kernel)?;
    // A register that does not load or validate is a server fault, never a 422.
    let register =
        state.store.statutory_register().await.map_err(|error| {
            RestError::internal(format!("statutory register unavailable: {error}"))
        })?;
    let items = register
        .loss_codes_on(insurer, on)
        .map(LossCodeDto::from)
        .collect();
    Ok(Json(LossCodePage { items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(insurer: Option<&str>, on: Option<&str>) -> LossCodeQuery {
        LossCodeQuery {
            insurer: insurer.map(str::to_owned),
            on: on.map(str::to_owned),
        }
    }

    #[test]
    fn query_requires_a_known_insurer_and_an_iso_date() {
        let (insurer, on) = parse_query(&query(Some("EI"), Some("2026-10-02"))).unwrap();
        assert_eq!(insurer, Insurer::Ei);
        assert_eq!(on.to_string(), "2026-10-02");
        for (q, field) in [
            (query(None, Some("2026-10-02")), "insurer"),
            (query(Some("ei"), Some("2026-10-02")), "insurer"),
            (query(Some("EI"), None), "on"),
            (query(Some("EI"), Some("2026-13-01")), "on"),
            (query(Some("EI"), Some("20261002")), "on"),
        ] {
            let error = parse_query(&q).unwrap_err();
            assert_eq!(error.field.as_deref(), Some(field), "{q:?}");
        }
    }
}
