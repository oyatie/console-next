//! LegalEntity (법인 / 개인사업자): input validation into a typed revision.

use console_kernel_core::kr::{CorpRegNo, PhoneE164};
use serde::{Deserialize, Serialize};

use crate::address::{AddressInput, KrAddress, validate_address};
use crate::codes::{
    BizKind, DirectorRole, PrioritySupport, PrioritySupportBasis, RepresentationMode, VatUnitMode,
};
use crate::refusal::{Issues, NOT_APPLICABLE, OUT_OF_RANGE, REQUIRED, Refusal, Warning};

#[path = "legal_entity_fields.rs"]
mod fields;
pub(crate) use fields::code_ref;
use fields::{directors, representatives};

/// A reference-list value as stored: code + label + list version (never a
/// bare code: a later list revision must not rewrite what was chosen). The
/// server stamps `label` and `version`; the client sends [`CodeInput`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    pub code: String,
    pub label: String,
    pub version: String,
}

/// A reference-list value as sent: the code only (INTEG-4). Any label or
/// version the client adds is ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeInput {
    pub code: Option<String>,
}

/// The list version stamped while no reference list is loaded: the code is
/// format-checked only and the UI shows 「코드 확인 필요」.
pub const CODE_UNVERIFIED: &str = "UNVERIFIED";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DirectorInput {
    pub role: Option<String>,
    pub name: Option<String>,
    pub appointed_on: Option<String>,
}

/// What the client sends to create or revise a legal entity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LegalEntityInput {
    pub biz_kind: Option<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::names::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub english_name: Option<Option<String>>,
    pub representation_mode: Option<String>,
    #[serde(default)]
    pub representatives: Vec<String>,
    pub additional_representatives: Option<i32>,
    pub crn: Option<String>,
    pub head_office_address: Option<AddressInput>,
    pub incorporated_on: Option<String>,
    pub fiscal_year_end_month: Option<i32>,
    pub capital_won: Option<i64>,
    /// 임원 in printed order. Omitted (`null`) on a revise: the current ones
    /// are kept; `[]` removes them all.
    pub directors: Option<Vec<DirectorInput>>,
    pub vat_unit_mode: Option<String>,
    pub main_ksic: Option<CodeInput>,
    pub main_phone: Option<String>,
    pub priority_support: Option<String>,
    pub priority_support_basis: Option<String>,
    pub large_group_member: Option<bool>,
    /// 설립 중 (catalog company-04): a 법인 recorded before its 설립등기, so
    /// with no 법인등록번호 yet. On a revise the server takes it from the
    /// record (it only ever ends, when the number is entered).
    pub founding: Option<bool>,
    /// 개업연월일 of the 사업자등록증 typed with it (create only): the first
    /// record starts there when no 설립일 is known (company-21).
    pub opened_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Director {
    pub role: DirectorRole,
    pub name: String,
    pub appointed_on: Option<time::Date>,
}

/// A validated legal entity revision (identity + revision fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegalEntityDraft {
    pub biz_kind: BizKind,
    pub crn: Option<CorpRegNo>,
    pub name: String,
    pub display_name: Option<String>,
    pub english_name: Option<Option<String>>,
    pub representation_mode: RepresentationMode,
    pub representatives: Vec<String>,
    pub additional_representatives: i32,
    pub head_office_address: Option<KrAddress>,
    pub incorporated_on: Option<time::Date>,
    pub fiscal_year_end_month: Option<i16>,
    pub capital_won: Option<i64>,
    /// `None`: unchanged (the adapter carries the current ones over).
    pub directors: Option<Vec<Director>>,
    pub declared_vat_unit_mode: Option<VatUnitMode>,
    pub main_ksic: Option<CodeRef>,
    pub main_phone: Option<PhoneE164>,
    pub priority_support: Option<(PrioritySupport, PrioritySupportBasis)>,
    pub large_group_member: Option<bool>,
    /// Still 설립 중: asked for and no 법인등록번호 entered yet.
    pub founding: bool,
    /// When the record's first revision starts, failing a 설립일.
    pub opened_on: Option<time::Date>,
}

/// Validate `input` as of `today` (KST). Returns the draft and its soft warnings.
///
/// # Errors
/// Every field issue at once (`validation_failed`).
pub fn validate_legal_entity(
    input: &LegalEntityInput,
    today: time::Date,
) -> Result<(LegalEntityDraft, Vec<Warning>), Refusal> {
    let mut is = Issues::default();
    let kind = is.choice("biz_kind", input.biz_kind.as_deref(), true, BizKind::parse);
    let corporation = kind == Some(BizKind::Corporation);
    let name = is.text("name", input.name.as_deref(), 200, true);
    let display_name = is.text("display_name", input.display_name.as_deref(), 40, false);
    let english_name =
        crate::names::optional_text(&mut is, "english_name", &input.english_name, 200);
    let mode = is.choice(
        "representation_mode",
        input.representation_mode.as_deref(),
        true,
        RepresentationMode::parse,
    );
    let representatives = representatives(&mut is, &input.representatives);
    let english = english_name.as_ref().and_then(|v| v.as_deref());
    if english.is_some_and(|n| !crate::names::is_latin_name(n)) {
        is.push("english_name", "english_name_not_latin");
    }
    if let Err(refusal) = crate::names::validate_names(
        [name.as_deref(), display_name.as_deref(), english],
        &representatives,
    ) {
        for field in refusal.fields {
            is.push(field.field, field.code);
        }
    }
    let additional = input.additional_representatives.unwrap_or(0);
    if !(0..=50).contains(&additional) {
        is.push("additional_representatives", OUT_OF_RANGE);
    }
    if let Some(mode) = mode {
        let total = representatives.len() + usize::try_from(additional.max(0)).unwrap_or(0);
        let fits = match mode {
            RepresentationMode::Single => total == 1,
            RepresentationMode::Several | RepresentationMode::Joint => total >= 2,
        };
        if !fits && !representatives.is_empty() {
            is.push("representation_mode", "representation_count_mismatch");
        }
    }
    let asked_founding = input.founding == Some(true);
    if asked_founding && kind.is_some() && !corporation {
        is.push("founding", NOT_APPLICABLE);
    }
    let founding = asked_founding && corporation;
    let crn = is.parsed(
        "crn",
        input.crn.as_deref(),
        corporation && !founding,
        CorpRegNo::parse,
    );
    if crn.is_some() && kind.is_some() && !corporation {
        is.push("crn", NOT_APPLICABLE);
    }
    let head_office_address = match (&input.head_office_address, corporation) {
        (Some(addr), _) => validate_address(&mut is, "head_office_address", addr),
        (None, true) => {
            is.push("head_office_address", REQUIRED);
            None
        }
        (None, false) => None,
    };
    let incorporated_on = is.date(
        "incorporated_on",
        input.incorporated_on.as_deref(),
        false,
        Some(today),
    );
    let opened_on = is.date("opened_on", input.opened_on.as_deref(), false, Some(today));
    let month = input.fiscal_year_end_month;
    if month.is_some_and(|m| !(1..=12).contains(&m)) {
        is.push("fiscal_year_end_month", OUT_OF_RANGE);
    }
    if input.capital_won.is_some_and(|c| c < 0) {
        is.push("capital_won", OUT_OF_RANGE);
    }
    let directors = input
        .directors
        .as_deref()
        .map(|raw| directors(&mut is, raw, today));
    let declared_vat_unit_mode = is.choice(
        "vat_unit_mode",
        input.vat_unit_mode.as_deref(),
        false,
        VatUnitMode::parse,
    );
    let main_ksic = input
        .main_ksic
        .as_ref()
        .and_then(|c| code_ref(&mut is, "main_ksic", c, None));
    let main_phone = is.parsed(
        "main_phone",
        input.main_phone.as_deref(),
        false,
        PhoneE164::parse,
    );
    let support = is.choice(
        "priority_support",
        input.priority_support.as_deref(),
        false,
        PrioritySupport::parse,
    );
    let basis = is.choice(
        "priority_support_basis",
        input.priority_support_basis.as_deref(),
        support.is_some(),
        PrioritySupportBasis::parse,
    );
    if support.is_none() && basis.is_some() {
        is.push("priority_support", REQUIRED);
    }
    let mut warnings = Vec::new();
    if let Some(crn) = &crn {
        for code in crn.warnings(incorporated_on) {
            warnings.push(Warning {
                field: "crn".into(),
                code,
            });
        }
    }
    // Entering the number ends the founding.
    let still_founding = founding && crn.is_none();
    is.finish_opt(|| {
        let draft = LegalEntityDraft {
            biz_kind: kind?,
            crn,
            name: name?,
            display_name,
            english_name,
            representation_mode: mode?,
            representatives,
            additional_representatives: additional,
            head_office_address,
            incorporated_on,
            fiscal_year_end_month: month.and_then(|m| i16::try_from(m).ok()),
            capital_won: input.capital_won,
            directors,
            declared_vat_unit_mode,
            main_ksic,
            main_phone,
            priority_support: support.zip(basis),
            large_group_member: input.large_group_member,
            founding: still_founding,
            opened_on,
        };
        Some((draft, warnings))
    })
}

#[cfg(test)]
#[path = "legal_entity_tests.rs"]
mod tests;
