//! Derive the VAT filing mode from recorded registrations.
use crate::Refusal;
use crate::codes::{VatUnitBasis, VatUnitMode};
use crate::refusal::REQUIRED;

/// The entity's VAT unit after a registration is added, or the refusal when
/// the facts no longer decide it (A-7: asked only once it matters).
///
/// - certificate ⑩ = Y → UNIT_TAXATION (derived), and it must be the only
///   open registration of the entity;
/// - one registration, ⑩ = N → PER_WORKPLACE (derived: 총괄납부 is meaningless
///   with one 사업장);
/// - two or more → a declaration is required (no default).
///
/// # Errors
/// `vat_unit_mode` required / mismatched, naming both values.
pub fn resolve_vat_unit_mode(
    declared: Option<VatUnitMode>,
    open_registrations_after: usize,
    unit_taxation: bool,
) -> Result<(VatUnitMode, VatUnitBasis), Refusal> {
    if unit_taxation {
        if open_registrations_after > 1 {
            return Err(Refusal::field(
                "unit_taxation",
                "unit_taxation_needs_single_registration",
            ));
        }
        if declared.is_some_and(|d| d != VatUnitMode::UnitTaxation) {
            return Err(Refusal::field(
                "unit_taxation",
                "unit_taxation_conflicts_with_vat_unit_mode",
            ));
        }
        return Ok((
            VatUnitMode::UnitTaxation,
            VatUnitBasis::CertificateUnitTaxation,
        ));
    }
    match declared {
        Some(VatUnitMode::UnitTaxation) => Err(Refusal::field(
            "unit_taxation",
            "unit_taxation_conflicts_with_vat_unit_mode",
        )),
        Some(mode) => Ok((mode, VatUnitBasis::Declared)),
        None if open_registrations_after <= 1 => {
            Ok((VatUnitMode::PerWorkplace, VatUnitBasis::SingleRegistration))
        }
        None => Err(Refusal::field("vat_unit_mode", REQUIRED).with_remedy("declare_vat_unit_mode")),
    }
}
