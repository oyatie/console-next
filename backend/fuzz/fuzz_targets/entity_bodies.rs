//! The 법인 / 사업장 / 사업자등록 request bodies as the entity routes take them
//! (`serde_json` into the domain `*Input`, then the domain validator), plus the
//! document upload and structure-code checks. The first byte picks the body.
//! Invariants: never panic; a refusal is a 409/422-shaped `Refusal` with a
//! stable snake_case code; a validated 법인 name is 1..=200 characters.
#![no_main]

use console_entity_domain::Refusal;
use console_entity_domain::codes::BizKind;
use console_entity_domain::correction::{
    IdentifierCorrectionInput, RegistrationChangeInput, validate_correction,
    validate_registration_change,
};
use console_entity_domain::cross_entity::{GrantBasisInput, check_grant_basis};
use console_entity_domain::document::validate_upload;
use console_entity_domain::legal_entity::{LegalEntityInput, validate_legal_entity};
use console_entity_domain::registration::{
    EntityContext, RegistrationInput, validate_registration,
};
use console_entity_domain::structure_code::structure_code;
use console_entity_domain::workplace::{WorkplaceContext, WorkplaceInput, validate_workplace};
use console_entity_domain::workplace_kind;
use libfuzzer_sys::fuzz_target;
use time::macros::date;

const TODAY: time::Date = date!(2026 - 10 - 07);

fn stable(r: &Refusal) {
    let ok = |c: &str| {
        !c.is_empty()
            && c.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    };
    assert!(ok(r.code), "unstable code {:?}", r.code);
    for f in &r.fields {
        assert!(ok(f.code), "unstable field code {:?}", f.code);
    }
}

fn check<T>(r: Result<T, Refusal>) -> Option<T> {
    r.map_err(|e| stable(&e)).ok()
}

fuzz_target!(|bytes: &[u8]| {
    let Some((&pick, body)) = bytes.split_first() else {
        return;
    };
    let kind = [
        None,
        Some(BizKind::Corporation),
        Some(BizKind::Individual),
        Some(BizKind::IdNumberOrg),
    ][usize::from(pick >> 5) % 4];
    let flag = pick & 0x10 != 0;
    match pick % 9 {
        0 => {
            let Ok(input) = serde_json::from_slice::<LegalEntityInput>(body) else {
                return;
            };
            if let Some((draft, _)) = check(validate_legal_entity(&input, TODAY)) {
                let n = draft.name.chars().count();
                assert!((1..=200).contains(&n), "name of {n} chars accepted");
            }
        }
        1 => {
            let Ok(input) = serde_json::from_slice::<WorkplaceInput>(body) else {
                return;
            };
            let ctx = WorkplaceContext {
                biz_kind: kind,
                registration_is_unit_taxation_of_other: flag,
                creating: !flag,
            };
            check(validate_workplace(&input, ctx, TODAY));
        }
        2 => {
            let Ok(input) = serde_json::from_slice::<RegistrationInput>(body) else {
                return;
            };
            check(validate_registration(
                &input,
                EntityContext {
                    biz_kind: kind,
                    head_trade_name: None,
                    entity_name: "주식회사 예시",
                },
                TODAY,
            ));
        }
        3 => {
            let Ok(input) = serde_json::from_slice::<IdentifierCorrectionInput>(body) else {
                return;
            };
            check(validate_correction(&input, flag));
        }
        4 => {
            let Ok(input) = serde_json::from_slice::<RegistrationChangeInput>(body) else {
                return;
            };
            check(validate_registration_change(&input, flag, TODAY));
        }
        5 => {
            let Ok(input) = serde_json::from_slice::<GrantBasisInput>(body) else {
                return;
            };
            check(check_grant_basis(flag, pick & 0x20 != 0, &input, TODAY));
        }
        6 => {
            let mut parts = body.splitn(3, |b| *b == 0);
            let kind = parts.next().and_then(|k| std::str::from_utf8(k).ok());
            let name = parts.next().and_then(|n| std::str::from_utf8(n).ok());
            check(validate_upload(
                kind,
                name,
                parts.next().unwrap_or_default().to_vec(),
            ));
        }
        7 => {
            let text = std::str::from_utf8(body).ok();
            check(structure_code("code", text));
            check(workplace_kind::code_shape(text));
            if let Some(label) = check(workplace_kind::label(text)) {
                assert!(!label.trim().is_empty());
            }
        }
        _ => {
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
                return;
            };
            let _ = serde_json::from_value::<LegalEntityInput>(value);
        }
    }
});
