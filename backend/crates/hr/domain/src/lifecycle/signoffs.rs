//! The lifecycle acknowledgements each event type requires.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct EmployeeLifecycleSignoffs {
    #[serde(default)]
    pub privacy_notice_ack: bool,
    #[serde(default)]
    pub korean_labor_law_ack: bool,
    #[serde(default)]
    pub payroll_cutoff_ack: bool,
    #[serde(default)]
    pub retirement_settlement_ack: bool,
}

/// The signoffs each lifecycle event requires (a missing one is 422
/// `lifecycle_signoff_required` naming the ack).
///
/// Decisions #3: a bare tick never guards a fact, so the lifecycle acts
/// require none (A13). The `signoffs` body is still accepted and stored as
/// sent. The exit acknowledgements belong to EXIT (BW-05) and stay until it
/// replaces them with its observed and attested facts.
///
/// | event_type | required acks |
/// |---|---|
/// | OFFBOARD, TERMINATE | `privacy_notice_ack`, `korean_labor_law_ack`, `payroll_cutoff_ack`, `retirement_settlement_ack` |
/// | every other event | none |
///
/// `cross_company` no longer matters (E-S3b): a TRANSFER that changes the
/// company is refused as a 전적 (409 `entity_change_needs_group_transfer`).
pub fn required_lifecycle_signoffs(
    event_type: &str,
    _cross_company: bool,
) -> &'static [&'static str] {
    const SETTLEMENT: &[&str] = &[
        "privacy_notice_ack",
        "korean_labor_law_ack",
        "payroll_cutoff_ack",
        "retirement_settlement_ack",
    ];
    match event_type {
        "OFFBOARD" | "TERMINATE" => SETTLEMENT,
        _ => &[],
    }
}

pub fn signoff_held(signoffs: &EmployeeLifecycleSignoffs, ack: &str) -> bool {
    match ack {
        "privacy_notice_ack" => signoffs.privacy_notice_ack,
        "korean_labor_law_ack" => signoffs.korean_labor_law_ack,
        "payroll_cutoff_ack" => signoffs.payroll_cutoff_ack,
        "retirement_settlement_ack" => signoffs.retirement_settlement_ack,
        _ => false,
    }
}
