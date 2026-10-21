//! Workplace (사업장): input validation and the derived 원천징수 unit.

use console_kernel_core::kr::{Email, PhoneE164, SubWorkplaceSerial};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::address::{AddressInput, KrAddress, validate_address};
use crate::codes::{BizKind, OperatingStatus, WithholdingMode};
use crate::insurance::{InsuranceDraft, InsuranceSetupInput, validate_insurance_setup};
use crate::refusal::{Issues, NOT_APPLICABLE, REQUIRED, Refusal};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkplaceInput {
    pub name: Option<String>,
    pub registration_id: Option<Uuid>,
    pub sub_serial: Option<String>,
    /// Reuse the registration's 사업장 소재지 (the certificate's own 사업장).
    #[serde(default)]
    pub same_address_as_registration: bool,
    pub address: Option<AddressInput>,
    pub mail_address: Option<AddressInput>,
    pub opened_on: Option<String>,
    pub representative_name: Option<String>,
    pub main_product: Option<String>,
    pub phone: Option<String>,
    pub fax: Option<String>,
    pub mobile: Option<String>,
    pub email: Option<String>,
    pub is_construction_site: Option<bool>,
    pub withholding_mode: Option<String>,
    pub bulk_filed_on: Option<String>,
    pub independent_lsa_unit: Option<bool>,
    pub independent_lsa_evidence: Option<String>,
    /// Required on create (no default); ignored on revise.
    pub insurance: Option<InsuranceSetupInput>,
    pub status: Option<String>,
    pub status_since: Option<String>,
    /// 휴업's expected end (SUSPENDED only).
    pub status_until: Option<String>,
    pub is_abstract: Option<bool>,
    pub reg_mode: Option<String>,
    pub not_registered_reason: Option<crate::legal_entity::CodeInput>,
}

/// Where the address comes from after validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum WorkplaceAddress {
    Own(Box<KrAddress>),
    SameAsRegistration,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkplaceDraft {
    pub name: String,
    pub registration_id: Option<Uuid>,
    pub sub_serial: Option<SubWorkplaceSerial>,
    pub not_registered_reason: Option<crate::legal_entity::CodeRef>,
    pub is_abstract: bool,
    pub address: WorkplaceAddress,
    pub mail_address: Option<KrAddress>,
    pub opened_on: time::Date,
    pub representative_name: Option<String>,
    pub main_product: Option<String>,
    pub phone: Option<PhoneE164>,
    pub fax: Option<PhoneE164>,
    pub mobile: Option<PhoneE164>,
    pub email: Option<Email>,
    pub is_construction_site: bool,
    pub withholding_mode: Option<WithholdingMode>,
    pub bulk_filed_on: Option<time::Date>,
    pub independent_lsa_unit: Option<bool>,
    pub independent_lsa_evidence: Option<String>,
    pub status: OperatingStatus,
    pub status_since: Option<time::Date>,
    pub status_until: Option<time::Date>,
    /// Present on create only.
    pub insurance: Vec<InsuranceDraft>,
}

/// Facts about the target the input is checked against.
#[derive(Debug, Clone, Copy)]
pub struct WorkplaceContext {
    pub biz_kind: Option<BizKind>,
    /// The chosen registration is a 사업자단위과세 one held by another 사업장.
    pub registration_is_unit_taxation_of_other: bool,
    pub creating: bool,
}

/// # Errors
/// Every field issue at once.
pub fn validate_workplace(
    input: &WorkplaceInput,
    ctx: WorkplaceContext,
    today: time::Date,
) -> Result<WorkplaceDraft, Refusal> {
    let mut is = Issues::default();
    let name = is.text("name", input.name.as_deref(), 200, true);
    let sub_serial = is.parsed(
        "sub_serial",
        input.sub_serial.as_deref(),
        ctx.registration_is_unit_taxation_of_other,
        SubWorkplaceSerial::parse,
    );
    if sub_serial.is_some() && !ctx.registration_is_unit_taxation_of_other {
        is.push("sub_serial", NOT_APPLICABLE);
    }
    let is_abstract = input.is_abstract.unwrap_or(false);
    if is_abstract && input.registration_id.is_some() {
        is.push("registration_id", NOT_APPLICABLE);
    }
    if is_abstract && input.sub_serial.is_some() {
        is.push("sub_serial", NOT_APPLICABLE);
    }

    let is_reg_mode_not_required = input.reg_mode.as_deref() == Some("NOT_REQUIRED");
    if is_reg_mode_not_required && input.registration_id.is_some() {
        is.push("registration_id", NOT_APPLICABLE);
    }

    let not_registered_reason =
        if input.registration_id.is_some() && input.not_registered_reason.is_some() {
            is.push("not_registered_reason", NOT_APPLICABLE);
            None
        } else if is_reg_mode_not_required {
            crate::workplace_registration::validate_not_registered_reason(
                &mut is,
                "not_registered_reason",
                input.not_registered_reason.as_ref(),
            )
        } else if let Some(raw) = input.not_registered_reason.as_ref() {
            crate::workplace_registration::validate_not_registered_reason(
                &mut is,
                "not_registered_reason",
                Some(raw),
            )
        } else {
            None
        };

    let address = if is_abstract {
        if input.address.is_some() || input.same_address_as_registration {
            is.push("address", NOT_APPLICABLE);
        }
        Some(WorkplaceAddress::None)
    } else {
        match (&input.address, input.same_address_as_registration) {
            (Some(_), true) => {
                is.push("address", NOT_APPLICABLE);
                None
            }
            (Some(addr), false) => validate_address(&mut is, "address", addr)
                .map(|a| WorkplaceAddress::Own(Box::new(a))),
            (None, true) if input.registration_id.is_some() => {
                Some(WorkplaceAddress::SameAsRegistration)
            }
            (None, true) => {
                is.push("address", NOT_APPLICABLE);
                None
            }
            (None, false) => {
                is.push("address", REQUIRED);
                None
            }
        }
    };
    let mail_address = input
        .mail_address
        .as_ref()
        .and_then(|a| validate_address(&mut is, "mail_address", a));
    let opened_on = is.date("opened_on", input.opened_on.as_deref(), true, None);
    let phone = |is: &mut Issues, f: &str, v: &Option<String>| {
        is.parsed(f, v.as_deref(), false, PhoneE164::parse)
    };
    let draft_phone = phone(&mut is, "phone", &input.phone);
    let fax = phone(&mut is, "fax", &input.fax);
    let mobile = phone(&mut is, "mobile", &input.mobile);
    let email = is.parsed("email", input.email.as_deref(), false, Email::parse);
    let withholding_mode = is.choice(
        "withholding_mode",
        input.withholding_mode.as_deref(),
        false,
        WithholdingMode::parse,
    );
    let bulk = withholding_mode == Some(WithholdingMode::HeadOfficeBulk);
    let bulk_filed_on = is.date(
        "bulk_filed_on",
        input.bulk_filed_on.as_deref(),
        bulk,
        Some(today),
    );
    if bulk_filed_on.is_some() && !bulk {
        is.push("bulk_filed_on", NOT_APPLICABLE);
    }
    let evidence = is.text(
        "independent_lsa_evidence",
        input.independent_lsa_evidence.as_deref(),
        500,
        input.independent_lsa_unit == Some(true),
    );
    // Create: a 사업장 is created CONTINUING (closing is a later revision).
    // Revise: the full state is sent, so the status is required.
    let status = is
        .choice(
            "status",
            input.status.as_deref(),
            !ctx.creating,
            OperatingStatus::parse,
        )
        .unwrap_or(OperatingStatus::Continuing);
    let status_since = is.date(
        "status_since",
        input.status_since.as_deref(),
        status != OperatingStatus::Continuing,
        Some(today),
    );
    let status_until = crate::suspension::status_until(
        &mut is,
        input.status_until.as_deref(),
        Some(status),
        status_since,
    );
    if ctx.creating && status != OperatingStatus::Continuing {
        is.push("status", "create_must_be_continuing");
    }
    let insurance = match (&input.insurance, ctx.creating) {
        (Some(setup), true) => validate_insurance_setup(&mut is, setup),
        (None, true) => {
            is.push("insurance", REQUIRED);
            Vec::new()
        }
        (_, false) => Vec::new(),
    };
    is.finish_opt(|| {
        Some(WorkplaceDraft {
            name: name?,
            registration_id: input.registration_id,
            sub_serial,
            not_registered_reason,
            is_abstract,
            address: address?,
            mail_address,
            opened_on: opened_on?,
            representative_name: input
                .representative_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.chars().take(100).collect()),
            main_product: input
                .main_product
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
            phone: draft_phone,
            fax,
            mobile,
            email,
            is_construction_site: input.is_construction_site.unwrap_or(false),
            withholding_mode,
            bulk_filed_on,
            independent_lsa_unit: input.independent_lsa_unit,
            independent_lsa_evidence: evidence,
            status,
            status_since,
            status_until,
            insurance,
        })
    })
}

/// Where a 사업장's 원천세 is filed (challenge A-4: derived, with its basis).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WithholdingTarget {
    /// This 사업장 is its own unit.
    SelfUnit { basis: &'static str },
    /// Filed through another 사업장 (the 본점).
    Workplace {
        workplace_id: Uuid,
        basis: &'static str,
    },
    /// The 본점 is an office with no 사업장 record.
    EntityHeadOffice { basis: &'static str },
    /// Not decidable yet; the fix is named.
    Undecided { remedy: &'static str },
}

/// Inputs to [`withholding_target`].
#[derive(Debug, Clone, Copy)]
pub struct WithholdingFacts {
    pub biz_kind: Option<BizKind>,
    pub mode: Option<WithholdingMode>,
    pub this_workplace: Uuid,
    pub head_office_workplace: Option<Uuid>,
    pub head_office_has_no_workplace: bool,
}

/// 소득세법 §7①3: a 법인's 원천징수 납세지 is its 본점 unless the 지점 keeps
/// independent accounts (§7①4) or bulk filing is approved (규정 §34).
/// For a 개인사업자 the rule (§7①1) is UNKNOWN pending verification, so the
/// mode must be chosen (no default).
#[must_use]
pub fn withholding_target(f: WithholdingFacts) -> WithholdingTarget {
    const HEAD: &str = "income_tax_act_7_1_3";
    const OWN: &str = "income_tax_act_7_1_4";
    const BULK: &str = "withholding_rules_34";
    let to_head = |basis| match (f.head_office_workplace, f.head_office_has_no_workplace) {
        (Some(id), _) if id == f.this_workplace => WithholdingTarget::SelfUnit { basis },
        (Some(id), _) => WithholdingTarget::Workplace {
            workplace_id: id,
            basis,
        },
        (None, true) => WithholdingTarget::EntityHeadOffice { basis },
        (None, false) => WithholdingTarget::Undecided {
            remedy: "set_head_office_workplace",
        },
    };
    match (f.biz_kind, f.mode) {
        (_, Some(WithholdingMode::OwnIndependentAccounts)) => {
            WithholdingTarget::SelfUnit { basis: OWN }
        }
        (_, Some(WithholdingMode::HeadOfficeBulk)) => to_head(BULK),
        (Some(BizKind::Corporation), _) | (_, Some(WithholdingMode::HeadOffice)) => to_head(HEAD),
        _ => WithholdingTarget::Undecided {
            remedy: "choose_withholding_mode",
        },
    }
}

#[cfg(test)]
#[path = "workplace_tests.rs"]
mod tests;
