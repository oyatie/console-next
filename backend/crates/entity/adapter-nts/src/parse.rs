// SPDX-License-Identifier: LicenseRef-Proprietary
use console_entity_application::registration_check::{
    CheckAnswer, CheckFailure, CheckKind, UnavailableReason,
};
use console_entity_domain::codes::OperatingStatus;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const PROVIDER_VERSION: &str = "nts-businessman/1.1.0";
pub const MAX_BATCH: usize = 100;
/// The documented daily quota; the gateway's per-second quota is unpublished.
pub const DAILY_QUOTA: i64 = 1_000_000;
pub const REFLECTION_LAG_DAYS: i64 = 2;

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub fn response(http: u16, body: &str, kind: CheckKind) -> Result<Vec<CheckAnswer>, CheckFailure> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| CheckFailure::Unavailable(UnavailableReason::ProviderDown))?;
    let code = value
        .get("code")
        .or_else(|| value.get("status_code"))
        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
    match code.as_deref() {
        Some("-4" | "20" | "30") => {
            return Err(CheckFailure::Unavailable(UnavailableReason::KeyRejected));
        }
        Some("31") => return Err(CheckFailure::Unavailable(UnavailableReason::KeyExpired)),
        Some("22" | "23") => {
            return Err(CheckFailure::RateLimited {
                retry_after_seconds: 60,
                gateway_code: code,
            });
        }
        Some("OK") if http == 200 => {}
        _ if http == 429 => {
            return Err(CheckFailure::RateLimited {
                retry_after_seconds: 60,
                gateway_code: code.filter(|v| v == "22" || v == "23"),
            });
        }
        _ => return Err(CheckFailure::Unavailable(UnavailableReason::ProviderDown)),
    }
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or(CheckFailure::Contract {
            code: "missing_data",
        })?;
    let digest = hex::encode(Sha256::digest(body.as_bytes()));
    data.iter()
        .map(|row| {
            let number = text(row, "b_no")
                .filter(|s| s.len() == 10 && s.bytes().all(|c| c.is_ascii_digit()))
                .ok_or(CheckFailure::Contract {
                    code: "invalid_response_number",
                })?;
            let valid = text(row, "valid");
            if kind == CheckKind::Validate && !matches!(valid.as_deref(), Some("01" | "02")) {
                return Err(CheckFailure::Contract {
                    code: "unknown_validation_result",
                });
            }
            let status = if kind == CheckKind::Status {
                row
            } else {
                row.get("status").unwrap_or(&Value::Null)
            };
            let status_code = text(status, "b_stt_cd");
            let reported_status = match status_code.as_deref() {
                Some("01") => Some(OperatingStatus::Continuing),
                Some("02") => Some(OperatingStatus::Suspended),
                Some("03") => Some(OperatingStatus::Closed),
                None => None,
                _ => {
                    return Err(CheckFailure::Contract {
                        code: "unknown_business_status",
                    });
                }
            };
            let fields_sent = match kind {
                CheckKind::Status => vec!["b_no".into()],
                CheckKind::Validate => vec!["b_no".into(), "start_dt".into(), "p_nm".into()],
            };
            Ok(CheckAnswer {
                brn_checked: number,
                kind,
                status_code,
                reported_status,
                tax_type_cd: text(status, "tax_type_cd"),
                end_dt: text(status, "end_dt"),
                utcc_yn: text(status, "utcc_yn"),
                tax_type_change_dt: text(status, "tax_type_change_dt"),
                invoice_apply_dt: text(status, "invoice_apply_dt"),
                rbf_tax_type_cd: text(status, "rbf_tax_type_cd"),
                valid,
                not_registered: kind == CheckKind::Status && reported_status.is_none(),
                fields_sent,
                response_sha256: digest.clone(),
                provider_version: PROVIDER_VERSION.into(),
            })
        })
        .collect()
}
