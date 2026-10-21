//! BusinessRegistration (사업자등록): one certificate's fields.

use console_kernel_core::kr::{BizRegNo, Email};
use serde::{Deserialize, Serialize};

use crate::address::{AddressInput, KrAddress, validate_address};
use crate::business_type::business_types;
pub use crate::business_type::{BusinessType, BusinessTypeInput};
use crate::codes::{BizKind, BrnPendingReason, CorrectionReason, IssueReasonKind, NtsTaxType};
use crate::refusal::{Issues, NOT_APPLICABLE, REQUIRED, Refusal, Warning};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RegistrationInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trade_name: Option<String>,
    pub brn: Option<String>,
    pub brn_pending_reason: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::names::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub classification_reason: Option<Option<String>>,
    pub opened_on: Option<String>,
    pub business_address: Option<AddressInput>,
    #[serde(default)]
    pub business_types: Vec<BusinessTypeInput>,
    pub production_factor: Option<String>,
    pub issue_reason_kind: Option<String>,
    pub issue_reason_sub: Option<String>,
    pub issue_reason_as_printed: Option<String>,
    #[serde(default)]
    pub co_owners: Vec<String>,
    pub liquor_license_no: Option<String>,
    pub unit_taxation: Option<bool>,
    pub e_invoice_email: Option<String>,
    pub cert_issued_on: Option<String>,
    pub tax_office_code: Option<String>,
    pub tax_office_label: Option<String>,
    pub tax_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistrationDraft {
    pub brn: Option<BizRegNo>,
    pub brn_pending_reason: Option<BrnPendingReason>,
    /// An individual certificate's printed 상호; other kinds store no name copy.
    pub trade_name: Option<String>,
    pub classification_reason: Option<Option<String>>,
    pub opened_on: time::Date,
    pub business_address: KrAddress,
    pub business_types: Vec<BusinessType>,
    pub production_factor: Option<String>,
    pub issue_reason: Option<(IssueReasonKind, Option<CorrectionReason>, Option<String>)>,
    pub co_owners: Vec<String>,
    pub liquor_license_no: Option<String>,
    pub unit_taxation: bool,
    pub e_invoice_email: Option<Email>,
    pub cert_issued_on: Option<time::Date>,
    pub tax_office_code: Option<String>,
    pub tax_office_label: String,
    pub tax_type: NtsTaxType,
}

/// What the entity already is, for the cross-checks a certificate must pass.
#[derive(Debug, Clone, Copy)]
pub struct EntityContext<'a> {
    pub biz_kind: Option<BizKind>,
    pub entity_name: &'a str,
    /// No head on create; a revision may have a legacy NULL 상호.
    pub head_trade_name: Option<Option<&'a str>>,
}

/// # Errors
/// Every field issue at once.
pub fn validate_registration(
    input: &RegistrationInput,
    ctx: EntityContext<'_>,
    today: time::Date,
) -> Result<(RegistrationDraft, Vec<Warning>), Refusal> {
    let mut is = Issues::default();
    let trade_name = if ctx.biz_kind == Some(BizKind::Individual) {
        match input.trade_name.as_deref() {
            Some(name) => is.text("trade_name", Some(name), 200, true),
            None => ctx
                .head_trade_name
                .unwrap_or(Some(ctx.entity_name))
                .map(str::to_owned),
        }
    } else {
        None
    };
    let pending = is.choice(
        "brn_pending_reason",
        input.brn_pending_reason.as_deref(),
        false,
        BrnPendingReason::parse,
    );
    let brn = is.parsed(
        "brn",
        input.brn.as_deref(),
        pending.is_none(),
        BizRegNo::parse,
    );
    if brn.is_some() && pending.is_some() {
        is.push("brn_pending_reason", NOT_APPLICABLE);
    }
    let classification_reason = crate::names::optional_text(
        &mut is,
        "classification_reason",
        &input.classification_reason,
        1000,
    );
    let opened_on = is.date("opened_on", input.opened_on.as_deref(), true, Some(today));
    let business_address = match &input.business_address {
        Some(addr) => validate_address(&mut is, "business_address", addr),
        None => {
            is.push("business_address", REQUIRED);
            None
        }
    };
    let business_types = business_types(&mut is, &input.business_types);
    let production_factor = is.text(
        "production_factor",
        input.production_factor.as_deref(),
        100,
        false,
    );
    let reason_kind = is.choice(
        "issue_reason_kind",
        input.issue_reason_kind.as_deref(),
        false,
        IssueReasonKind::parse,
    );
    let reason_sub = is.choice(
        "issue_reason_sub",
        input.issue_reason_sub.as_deref(),
        false,
        CorrectionReason::parse,
    );
    if reason_sub.is_some() && reason_kind != Some(IssueReasonKind::Correction) {
        is.push("issue_reason_sub", NOT_APPLICABLE);
    }
    let reason_text = is.text(
        "issue_reason_as_printed",
        input.issue_reason_as_printed.as_deref(),
        200,
        false,
    );
    if reason_kind == Some(IssueReasonKind::OtherAsPrinted) && reason_text.is_none() {
        is.push("issue_reason_as_printed", REQUIRED);
    }
    let co_owners = co_owners(&mut is, &input.co_owners, ctx.biz_kind);
    let liquor_license_no = is.text(
        "liquor_license_no",
        input.liquor_license_no.as_deref(),
        40,
        false,
    );
    if input.unit_taxation.is_none() {
        is.push("unit_taxation", REQUIRED);
    }
    let e_invoice_email = is.parsed(
        "e_invoice_email",
        input.e_invoice_email.as_deref(),
        false,
        Email::parse,
    );
    let cert_issued_on = is.date(
        "cert_issued_on",
        input.cert_issued_on.as_deref(),
        false,
        Some(today),
    );
    let tax_office_code = is.text(
        "tax_office_code",
        input.tax_office_code.as_deref(),
        20,
        false,
    );
    let tax_office_label = is.text(
        "tax_office_label",
        input.tax_office_label.as_deref(),
        60,
        true,
    );
    let tax_type = is.choice(
        "tax_type",
        input.tax_type.as_deref(),
        true,
        NtsTaxType::parse,
    );
    if let (Some(opened), Some(issued)) = (opened_on, cert_issued_on)
        && issued < opened
    {
        is.push("cert_issued_on", "issued_before_opened");
    }

    let mut warnings = Vec::new();
    if let Some(brn) = &brn {
        warnings.extend(brn.warnings().into_iter().map(|code| Warning {
            field: "brn".into(),
            code,
        }));
    }
    is.finish_opt(|| {
        let draft = RegistrationDraft {
            brn,
            brn_pending_reason: pending,
            trade_name,
            classification_reason,
            opened_on: opened_on?,
            business_address: business_address?,
            business_types,
            production_factor,
            issue_reason: reason_kind.map(|k| (k, reason_sub, reason_text)),
            co_owners,
            liquor_license_no,
            unit_taxation: input.unit_taxation?,
            e_invoice_email,
            cert_issued_on,
            tax_office_code,
            tax_office_label: tax_office_label?,
            tax_type: tax_type?,
        };
        Some((draft, warnings))
    })
}

fn co_owners(is: &mut Issues, raw: &[String], kind: Option<BizKind>) -> Vec<String> {
    if raw.is_empty() {
        return Vec::new();
    }
    if kind.is_some_and(|k| k != BizKind::Individual) {
        is.push("co_owners", NOT_APPLICABLE);
        return Vec::new();
    }
    raw.iter()
        .enumerate()
        .filter_map(|(i, n)| is.text(&format!("co_owners[{i}]"), Some(n), 100, true))
        .collect()
}

pub use crate::registration_vat::resolve_vat_unit_mode;

#[cfg(test)]
#[path = "registration_tests.rs"]
mod tests;
