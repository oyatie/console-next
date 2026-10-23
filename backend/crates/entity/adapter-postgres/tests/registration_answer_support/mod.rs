// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use crate::common::address;
use console_entity_application::CreateWorkplace;
use console_entity_domain::{
    Refusal, insurance::InsuranceSetupInput, legal_entity::CodeInput, workplace::WorkplaceInput,
    workplace_registration::ResolvedReferenceCode,
};
use uuid::Uuid;
pub fn change(
    registration: Uuid,
    serial: Option<&str>,
    on: &str,
) -> console_entity_domain::correction::RegistrationChangeInput {
    console_entity_domain::correction::RegistrationChangeInput {
        registration_id: Some(registration),
        sub_serial: serial.map(Into::into),
        effective_from: Some(on.into()),
        reason_code: Some("BRANCH_CONSOLIDATED".into()),
    }
}
pub fn not_registered(name: &str, is_abstract: bool) -> CreateWorkplace {
    CreateWorkplace {
        input: WorkplaceInput {
            name: Some(name.into()),
            reg_mode: Some("NOT_REQUIRED".into()),
            not_registered_reason: Some(CodeInput {
                code: Some(if is_abstract {
                    "REMOTE_TELEWORK".into()
                } else {
                    "VAT_DEPOT".into()
                }),
                version: Some("2026-10-22".into()),
            }),
            is_abstract: Some(is_abstract),
            address: (!is_abstract).then(|| address("서울특별시 강남구 테헤란로 153")),
            opened_on: Some("2020-03-02".into()),
            insurance: Some(InsuranceSetupInput {
                shortcut: Some("NONE_YET".into()),
                insurers: vec![],
            }),
            ..WorkplaceInput::default()
        },
        is_primary: None,
        is_head_office: Some(false),
        default_branch_id: None,
        kind_code: None,
    }
}

pub fn resolve(raw: &CodeInput) -> Result<ResolvedReferenceCode, Refusal> {
    if raw.version.as_deref().is_some_and(|v| v != "2026-10-22") {
        return Err(Refusal::field(
            "not_registered_reason",
            "reference_version_retired",
        ));
    }
    let (code, label, abstract_workplace) = match raw.code.as_deref() {
        Some("VAT_DEPOT") => ("VAT_DEPOT", "하치장", false),
        Some("REMOTE_TELEWORK") => ("REMOTE_TELEWORK", "주소 없는 원격 근무지 묶음", true),
        _ => return Err(Refusal::field("not_registered_reason", "invalid_option")),
    };
    Ok(ResolvedReferenceCode {
        code: code.into(),
        label: label.into(),
        list_key: "workplace_not_registered_reason".into(),
        version: "2026-10-22".into(),
        abstract_workplace,
    })
}
