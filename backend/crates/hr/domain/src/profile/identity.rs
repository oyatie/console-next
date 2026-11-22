// SPDX-License-Identifier: LicenseRef-Proprietary
//! Identity-type rules shared across directory, profile, import, and lifecycle workflows.

use super::enums::IdType;

/// Parse an import identity-type cell or alias.
///
/// Preserves `"ARC"` as the canonical database/API code while admitting `"FOREIGNER_REG"` as an
/// import alias.
#[must_use]
pub fn parse_id_type_import(raw: &str) -> Option<IdType> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    if let Ok(parsed) = IdType::parse(&upper) {
        return Some(parsed);
    }
    match upper.as_str() {
        "FOREIGNER_REG" | "FOREIGNER" | "ALIEN_REG" => Some(IdType::Arc),
        _ => None,
    }
}

/// Infer the default identity type from the 7th digit of a 13-digit registration number.
///
/// Digits `1..=4` classify as citizen `RRN`, and `5..=8` default to `ARC` unless
/// `DOMESTIC_RESIDENCE` is explicitly specified.
#[must_use]
pub fn infer_id_type_from_seventh(seventh: u8) -> Option<IdType> {
    match seventh {
        1..=4 => Some(IdType::Rrn),
        5..=8 => Some(IdType::Arc),
        _ => None,
    }
}

/// Enforce that `NOT_ISSUED` is only permitted when `employment_status` is `PRE_HIRE`.
///
/// # Errors
/// Returns `"not_issued_requires_pre_hire"` when `NOT_ISSUED` is paired with any non-`PRE_HIRE`
/// status.
pub fn validate_id_type_for_status(
    id_type: Option<IdType>,
    employment_status: &str,
) -> Result<(), &'static str> {
    if id_type == Some(IdType::NotIssued) && employment_status != "PRE_HIRE" {
        return Err("not_issued_requires_pre_hire");
    }
    Ok(())
}

/// Validate pairing between an optional explicit `IdType`, an optional registration number's 7th
/// digit and MOJ Mod-11 result, and an optional employment status.
///
/// # Errors
/// Returns a machine-readable reason code when status admission, digit-to-type compatibility, or
/// the Mod-11 check digit for `ARC` / `DOMESTIC_RESIDENCE` fails.
pub fn validate_id_pair(
    explicit: Option<IdType>,
    seventh: Option<u8>,
    passes_mod11: bool,
    employment_status: Option<&str>,
) -> Result<Option<IdType>, &'static str> {
    if let Some(status) = employment_status {
        validate_id_type_for_status(explicit, status)?;
    }
    match (explicit, seventh) {
        (Some(IdType::NotIssued), Some(_)) => Err("not_issued_with_rrn"),
        (Some(IdType::NotIssued), None) => Ok(Some(IdType::NotIssued)),
        (None, None) => Ok(None),
        (Some(id_type), None) => Ok(Some(id_type)),
        (explicit_opt, Some(digit)) => match digit {
            1..=4 => match explicit_opt {
                Some(IdType::Arc | IdType::DomesticResidence) => Err("id_type_rrn_mismatch"),
                Some(IdType::NotIssued) => Err("not_issued_with_rrn"),
                None | Some(IdType::Rrn) => Ok(Some(IdType::Rrn)),
            },
            5..=8 => {
                let effective = match explicit_opt {
                    Some(IdType::Rrn) => return Err("id_type_rrn_mismatch"),
                    Some(IdType::NotIssued) => return Err("not_issued_with_rrn"),
                    Some(IdType::DomesticResidence) => IdType::DomesticResidence,
                    None | Some(IdType::Arc) => IdType::Arc,
                };
                if !passes_mod11 {
                    return Err("rrn_mod11_invalid");
                }
                Ok(Some(effective))
            }
            _ => Err("rrn_invalid"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        infer_id_type_from_seventh, parse_id_type_import, validate_id_pair,
        validate_id_type_for_status,
    };
    use crate::profile::enums::IdType;

    #[test]
    fn import_parser_normalizes_foreigner_reg_and_codes() {
        assert_eq!(parse_id_type_import("FOREIGNER_REG"), Some(IdType::Arc));
        assert_eq!(parse_id_type_import("arc"), Some(IdType::Arc));
        assert_eq!(
            parse_id_type_import("DOMESTIC_RESIDENCE"),
            Some(IdType::DomesticResidence)
        );
        assert_eq!(parse_id_type_import("NOT_ISSUED"), Some(IdType::NotIssued));
        assert_eq!(parse_id_type_import("unknown"), None);
    }

    #[test]
    fn not_issued_requires_pre_hire_status() {
        assert_eq!(
            validate_id_type_for_status(Some(IdType::NotIssued), "PRE_HIRE"),
            Ok(())
        );
        for status in ["ACTIVE", "ON_LEAVE", "EXITED"] {
            assert_eq!(
                validate_id_type_for_status(Some(IdType::NotIssued), status),
                Err("not_issued_requires_pre_hire")
            );
        }
        assert_eq!(
            validate_id_type_for_status(Some(IdType::Rrn), "ACTIVE"),
            Ok(())
        );
    }

    #[test]
    fn pairs_validate_digits_and_mod11_for_arc_and_domestic_residence() {
        assert_eq!(infer_id_type_from_seventh(1), Some(IdType::Rrn));
        assert_eq!(infer_id_type_from_seventh(6), Some(IdType::Arc));
        assert_eq!(
            validate_id_pair(None, Some(3), false, Some("ACTIVE")),
            Ok(Some(IdType::Rrn))
        );
        assert_eq!(
            validate_id_pair(
                Some(IdType::DomesticResidence),
                Some(6),
                true,
                Some("ACTIVE")
            ),
            Ok(Some(IdType::DomesticResidence))
        );
        assert_eq!(
            validate_id_pair(None, Some(5), false, Some("ACTIVE")),
            Err("rrn_mod11_invalid")
        );
        assert_eq!(
            validate_id_pair(Some(IdType::Rrn), Some(5), true, Some("ACTIVE")),
            Err("id_type_rrn_mismatch")
        );
        assert_eq!(
            validate_id_pair(Some(IdType::Arc), Some(2), true, Some("ACTIVE")),
            Err("id_type_rrn_mismatch")
        );
        assert_eq!(
            validate_id_pair(Some(IdType::NotIssued), None, false, Some("PRE_HIRE")),
            Ok(Some(IdType::NotIssued))
        );
        assert_eq!(
            validate_id_pair(Some(IdType::NotIssued), Some(1), true, Some("PRE_HIRE")),
            Err("not_issued_with_rrn")
        );
    }
}
