//! Settlement maths, certification digest and wage-basis payloads (moved
//! from `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::case::ExitCaseContext;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_payroll_domain::{
    ProfessionalReviewerKind, ProfessionalValidation, SeverancePayInput, build_severance_pay_draft,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::HrError;
use crate::digest::sha256_hex;
use crate::exits::types::ExitSettlementInput;

pub type SettlementCalculation = (
    &'static str,
    Option<i32>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Vec<String>,
    // 통상임금 (ordinary-wage) statutory basis (0093 review HIGH #2), all `None`
    // until the wage source arrives: monthly ordinary wage, derived ordinary
    // daily wage, and the daily wage that actually governed severance.
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

/// 월 소정근로시간 (statutory monthly standard hours) for a 주40시간 worker.
pub const MONTHLY_STANDARD_HOURS: i64 = 209;

/// 1일 소정근로시간 (contractual daily hours).
pub const DAILY_CONTRACTUAL_HOURS: i64 = 8;

/// 통상일급 (1-day ordinary wage) from the monthly 통상임금 via the statutory
/// 기준시간 rule: 통상시급 = 월 통상임금 / 209h, 통상일급 = 통상시급 × 8h.
///
/// STANDARD-WORKER ASSUMPTION (explicit, v1 scope): 209h/month and 8h/day are the
/// 주40시간·1일 8시간 standard-worker convention (the official Minimum Wage
/// Commission tables publish hourly, 8-hour daily, and "monthly (209h basis)"
/// figures on exactly this basis). This derivation is valid ONLY for standard
/// 40h-week / 8h-day workers; non-standard schedules (shorter contractual hours,
/// shift patterns) need schedule-specific monthly standard hours and are OUT OF
/// v1 SCOPE.
///
/// 0093 review HIGH #3 (money bug): multiply BEFORE dividing —
/// `(monthly * 8) / 209`, not `(monthly / 209) * 8` — in checked i128 wide
/// arithmetic. Flooring `monthly / 209` first understated the daily figure by up
/// to 7 won/day, which under-paid severance whenever the ordinary floor governed.
pub fn ordinary_daily_wage_won_from_monthly(
    monthly_ordinary_wage_won: i64,
) -> Result<i64, HrError> {
    let daily = i128::from(monthly_ordinary_wage_won) * i128::from(DAILY_CONTRACTUAL_HOURS)
        / i128::from(MONTHLY_STANDARD_HOURS);
    i64::try_from(daily).map_err(|_| HrError::validation("ordinary daily wage overflow"))
}

/// Deterministic SHA-256 that binds a settlement package's CERTIFIED state to
/// the exact revision a 노무사/세무사 signed off (0093 HIGH: a non-null artifact
/// only proves an artifact exists, not that it certified *these* numbers).
///
/// Covers every certification-relevant field persisted on the row: the
/// severance figure, the statutory basis, the insurance-loss payload, the
/// approval payload, the wage-source-derived inputs (period bounds, calendar
/// days, wage total, average daily wage, service days), AND the 통상임금
/// (ordinary-wage) basis (monthly ordinary wage, derived ordinary daily wage,
/// and the statutory daily wage that governed). The ordinary-wage basis is bound
/// DIRECTLY (0093 review HIGH #2): binding it only transitively via
/// `severance_pay_won` was false, because the ordinary wage can change while the
/// average wage still governs, or two ordinary inputs can floor to the same
/// severance.
///
/// This covered-field set MUST stay byte-identical to the certification-covered
/// column set enforced by migration 0094's
/// `enforce_settlement_certification_reset()` BEFORE UPDATE trigger — the two are
/// cross-referenced so any covered write invalidates a stale certification.
///
/// Order-stable: this workspace builds `serde_json` without `preserve_order`, so
/// its object map is a `BTreeMap` that serializes with sorted keys, and embedded
/// JSONB values round-trip through the same `BTreeMap`. Identical inputs
/// therefore always hash identically regardless of column or JSON key order.
/// Recursively re-key every JSON object in sorted key order so a digest over the
/// result is canonical regardless of serde_json's `preserve_order` feature. A
/// transitive dependency (e.g. cedar-policy -> schemars) can enable
/// `serde_json/preserve_order` workspace-wide, flipping `Value` objects from a
/// sorted `BTreeMap` to an insertion-order `IndexMap`; a statutory certification
/// digest must never depend on such a global cargo feature. Sorting at every
/// level yields the same bytes serde_json produced by default (sorted) before any
/// such feature was present, so this does NOT change any already-stored digest.
pub fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            Value::Object(
                sorted
                    .into_iter()
                    .map(|(k, v)| (k.clone(), canonical_json(v)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        scalar => scalar.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn compute_certified_package_digest(
    severance_pay_won: Option<i64>,
    statutory_basis: &Value,
    insurance_loss_payload: &Value,
    approval_payload: &Value,
    average_wage_period_start: Option<&str>,
    average_wage_period_end: Option<&str>,
    average_wage_calendar_days: Option<i32>,
    average_wage_total_won: Option<i64>,
    average_daily_wage_milliwon: Option<i64>,
    service_days: Option<i32>,
    monthly_ordinary_wage_won: Option<i64>,
    ordinary_daily_wage_won: Option<i64>,
    statutory_daily_wage_milliwon: Option<i64>,
) -> String {
    let canonical = json!({
        "severance_pay_won": severance_pay_won,
        "statutory_basis": statutory_basis,
        "insurance_loss_payload": insurance_loss_payload,
        "approval_payload": approval_payload,
        "average_wage_period_start": average_wage_period_start,
        "average_wage_period_end": average_wage_period_end,
        "average_wage_calendar_days": average_wage_calendar_days,
        "average_wage_total_won": average_wage_total_won,
        "average_daily_wage_milliwon": average_daily_wage_milliwon,
        "service_days": service_days,
        "monthly_ordinary_wage_won": monthly_ordinary_wage_won,
        "ordinary_daily_wage_won": ordinary_daily_wage_won,
        "statutory_daily_wage_milliwon": statutory_daily_wage_milliwon,
    });
    // `canonical_json` sorts every object key recursively so the digest is
    // independent of serde_json's `preserve_order` feature (a transitive dep can
    // enable it workspace-wide). `Value::to_string()` is serde_json's infallible
    // `Display` serializer (same compact bytes as `serde_json::to_vec`), so the
    // money path carries no panic branch (also avoids the `clippy::expect_used`
    // deny without an allow).
    sha256_hex(canonical_json(&canonical).to_string().as_bytes())
}

/// Stamps the EFFECTIVE `certification_status` onto a generated payload
/// (insurance-loss or approval) so any surface that renders or exports the
/// payload directly can still derive the "산정 초안 — 노무사 검증 전" marker
/// (pre-mortem #4: the label must never be hand-placed per surface, only
/// derived from this single computed value). No-op if the payload isn't a
/// JSON object.
pub fn with_certification_status_marker(mut payload: Value, certification_status: &str) -> Value {
    if let Value::Object(map) = &mut payload {
        map.insert(
            "certification_status".to_owned(),
            Value::String(certification_status.to_owned()),
        );
    }
    payload
}

/// Embeds the 통상임금 (ordinary-wage) statutory basis into a generated payload
/// (insurance-loss or approval) so the filed MOEL/NHIS document itself records
/// which ordinary-wage input was compared against the average wage (0093 review
/// HIGH #2 — the money trail must be auditable in the document, not just on the
/// row). No-op unless the payload is a JSON object AND all three basis figures
/// are present (i.e. the package reached READY_FOR_APPROVAL).
pub fn with_ordinary_wage_basis(
    mut payload: Value,
    monthly_ordinary_wage_won: Option<i64>,
    ordinary_daily_wage_won: Option<i64>,
    statutory_daily_wage_milliwon: Option<i64>,
) -> Value {
    if let (Value::Object(map), Some(monthly), Some(daily), Some(statutory_daily)) = (
        &mut payload,
        monthly_ordinary_wage_won,
        ordinary_daily_wage_won,
        statutory_daily_wage_milliwon,
    ) {
        map.insert(
            "ordinary_wage_basis".to_owned(),
            json!({
                "monthly_ordinary_wage_won": monthly,
                "ordinary_daily_wage_won": daily,
                "statutory_daily_wage_milliwon": statutory_daily,
            }),
        );
    }
    payload
}

/// Serialize a `ProfessionalValidation` into the exact 4-key JSON artifact that
/// migration 0093's `..._cert_artifact_shape_chk` CHECK requires, emitting
/// `reviewer_kind` as exactly `LABOR_ATTORNEY` / `TAX_ACCOUNTANT`.
///
/// This is the write-side shape a future 노무사 certification-recording endpoint
/// persists. v1 ships no such endpoint, so `CERTIFIED` is unreachable-by-design
/// in production (safe — nothing gates on it yet, and the atomic reset in every
/// settlement UPDATE plus the digest-match honoring below hold the invariant the
/// moment a recording path is added). It is exercised by the certification tests.
// The certification tests that exercise it are `#[cfg(feature =
// "test-postgres")]`, so it is unused in a plain `cfg(test)` build too.
#[allow(dead_code)]
pub fn certification_artifact_json(validation: &ProfessionalValidation) -> Value {
    let reviewer_kind = match validation.reviewer_kind {
        ProfessionalReviewerKind::LaborAttorney => "LABOR_ATTORNEY",
        ProfessionalReviewerKind::TaxAccountant => "TAX_ACCOUNTANT",
    };
    json!({
        "reviewer_kind": reviewer_kind,
        "reviewed_on": validation.reviewed_on.to_string(),
        "artifact_sha256": validation.artifact_sha256,
        "reviewer_reference": validation.reviewer_reference,
    })
}

pub fn build_settlement_calculation(
    context: &ExitCaseContext,
    input: Option<&ExitSettlementInput>,
) -> Result<SettlementCalculation, HrError> {
    let mut missing = Vec::new();
    let Some(hire_date_text) = context.hire_date.as_deref() else {
        missing.push("hire_date".to_owned());
        missing.extend(missing_wage_source_fields());
        return Ok((
            "NEEDS_SOURCE",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            missing,
            None,
            None,
            None,
        ));
    };
    let hire_date = parse_yyyy_mm_dd(hire_date_text)?;
    let exit_date = parse_yyyy_mm_dd(&context.effective_exit_date)?;
    let service_days = exit_date
        .to_julian_day()
        .saturating_sub(hire_date.to_julian_day())
        + 1;

    let Some(input) = input else {
        missing.extend(missing_wage_source_fields());
        return Ok((
            "NEEDS_SOURCE",
            Some(service_days),
            None,
            None,
            None,
            None,
            None,
            None,
            missing,
            None,
            None,
            None,
        ));
    };

    let period_start = parse_yyyy_mm_dd(&input.average_wage_period_start)?;
    let period_end = parse_yyyy_mm_dd(&input.average_wage_period_end)?;
    // 통상일급 (1-day ordinary wage) derived from the monthly 통상임금 via the
    // 기준시간 209h/8h rule (see `ordinary_daily_wage_won_from_monthly`). This
    // derivation policy lives in the app layer, not the payroll kernel (which
    // only enforces the max(average, ordinary) floor). Fail loud rather than
    // default so the depressed-window population is never under-calculated by
    // silently skipping the floor.
    if input.monthly_ordinary_wage_won <= 0 {
        return Err(HrError::validation(
            "monthly ordinary wage (월 통상임금) is required and must be positive for the 통상임금 floor",
        ));
    }
    let ordinary_daily_wage_won =
        ordinary_daily_wage_won_from_monthly(input.monthly_ordinary_wage_won)?;
    let draft = build_severance_pay_draft(SeverancePayInput {
        hire_date,
        exit_date,
        average_wage_period_start: period_start,
        average_wage_period_end: period_end,
        average_wage_calendar_days: input.average_wage_calendar_days,
        average_wage_total_won: input.average_wage_total_won,
        ordinary_daily_wage_won,
    })
    .map_err(HrError::from_kernel)?;

    let service_days = i32::try_from(draft.service_days)
        .map_err(|_| HrError::validation("service days overflow"))?;
    let calendar_days = i32::try_from(draft.average_wage_calendar_days)
        .map_err(|_| HrError::validation("average wage calendar days overflow"))?;
    Ok((
        "READY_FOR_APPROVAL",
        Some(service_days),
        Some(draft.average_wage_period_start.to_string()),
        Some(draft.average_wage_period_end.to_string()),
        Some(calendar_days),
        Some(draft.average_wage_total_won),
        Some(draft.average_daily_wage_milliwon),
        Some(draft.severance_pay_won),
        missing,
        // 통상임금 basis (0093 review HIGH #2): monthly input, derived daily, and
        // the daily wage that actually governed = max(average, ordinary).
        Some(input.monthly_ordinary_wage_won),
        Some(draft.ordinary_daily_wage_won),
        Some(draft.statutory_daily_wage_milliwon),
    ))
}

pub fn missing_wage_source_fields() -> Vec<String> {
    vec![
        "average_wage_period_start".to_owned(),
        "average_wage_period_end".to_owned(),
        "average_wage_calendar_days".to_owned(),
        "average_wage_total_won".to_owned(),
        "pre_exit_three_month_wage_sources".to_owned(),
    ]
}
