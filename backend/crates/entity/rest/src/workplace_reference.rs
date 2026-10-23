// SPDX-License-Identifier: LicenseRef-Proprietary
use console_entity_domain::{
    Refusal, legal_entity::CodeInput, workplace_registration::ResolvedReferenceCode,
};

pub(crate) fn resolve_workplace_reason(raw: &CodeInput) -> Result<ResolvedReferenceCode, Refusal> {
    let resolved = console_refdata::resolve(
        console_refdata::WORKPLACE_NOT_REGISTERED_REASON_KEY,
        raw.code.as_deref().unwrap_or_default().trim(),
        raw.version.as_deref(),
    )
    .map_err(|error| {
        Refusal::field(
            "not_registered_reason",
            match error {
                console_refdata::ResolveError::RetiredVersion => "reference_version_retired",
                _ => "invalid_option",
            },
        )
    })?;
    Ok(ResolvedReferenceCode {
        code: resolved.code.code.into(),
        label: resolved.code.label.into(),
        list_key: resolved.list.key.into(),
        version: resolved.list.version.unwrap_or_default().into(),
        abstract_workplace: resolved.code.abstract_workplace.unwrap_or(false),
    })
}
