//! 4대보험 relation of a 사업장, per insurer, and the one-choice setup shortcut.

use console_kernel_core::kr::InsuranceMgmtNo;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::codes::{
    IaciBusinessForm, InsuranceShortcut, InsuranceStatus, InsuranceUnitMode, Insurer,
    NhisWorkplaceClass,
};
use crate::refusal::{Issues, NOT_APPLICABLE, OUT_OF_RANGE, REQUIRED};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InsurerInput {
    pub insurer: Option<String>,
    pub status: Option<String>,
    pub mgmt_no: Option<String>,
    pub established_on: Option<String>,
    pub unit_mode: Option<String>,
    pub main_workplace_id: Option<Uuid>,
    pub nps_separate_application: Option<bool>,
    pub nhis_unit_workplace_code: Option<String>,
    pub nhis_branch_office_code: Option<String>,
    pub nhis_workplace_class: Option<String>,
    pub iaci_business_type_code: Option<String>,
    pub iaci_business_type_label: Option<String>,
    pub iaci_insurance_year: Option<i16>,
    pub iaci_business_form: Option<String>,
    pub iaci_term_from: Option<String>,
    pub iaci_term_to: Option<String>,
    pub prime_contractor_mgmt_no: Option<String>,
}

/// 「4대보험: 모두 성립·번호는 나중에 · 모두 성립·지금 입력 · 아직 없음 · 공단별로 다름」,
/// with no default. `insurers` carries the per-insurer detail the choice needs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InsuranceSetupInput {
    pub shortcut: Option<String>,
    #[serde(default)]
    pub insurers: Vec<InsurerInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InsuranceDraft {
    pub insurer: Insurer,
    pub status: InsuranceStatus,
    pub mgmt_no: Option<InsuranceMgmtNo>,
    pub established_on: Option<time::Date>,
    pub unit_mode: InsuranceUnitMode,
    pub main_workplace_id: Option<Uuid>,
    pub nps_separate_application: Option<bool>,
    pub nhis_unit_workplace_code: Option<String>,
    pub nhis_branch_office_code: Option<String>,
    pub nhis_workplace_class: Option<NhisWorkplaceClass>,
    pub iaci_business_type: Option<(String, String, i16)>,
    pub iaci_business_form: Option<IaciBusinessForm>,
    pub iaci_term: Option<(time::Date, time::Date)>,
    pub prime_contractor_mgmt_no: Option<InsuranceMgmtNo>,
}

impl InsuranceDraft {
    fn bare(insurer: Insurer, status: InsuranceStatus) -> Self {
        Self {
            insurer,
            status,
            mgmt_no: None,
            established_on: None,
            unit_mode: InsuranceUnitMode::Own,
            main_workplace_id: None,
            nps_separate_application: None,
            nhis_unit_workplace_code: None,
            nhis_branch_office_code: None,
            nhis_workplace_class: None,
            iaci_business_type: None,
            iaci_business_form: None,
            iaci_term: None,
            prime_contractor_mgmt_no: None,
        }
    }
}

/// Expand the shortcut into one draft per insurer. A new 사업장 is its own
/// unit (OWN) unless the detail says PART_OF a 주된 사업장.
pub fn validate_insurance_setup(
    is: &mut Issues,
    input: &InsuranceSetupInput,
) -> Vec<InsuranceDraft> {
    let Some(shortcut) = is.choice(
        "insurance.shortcut",
        input.shortcut.as_deref(),
        true,
        InsuranceShortcut::parse,
    ) else {
        return Vec::new();
    };
    let all = |status| {
        Insurer::ALL
            .iter()
            .map(|i| InsuranceDraft::bare(*i, status))
            .collect()
    };
    match shortcut {
        InsuranceShortcut::AllEstablishedNumbersLater => {
            all(InsuranceStatus::EstablishedNumberPending)
        }
        InsuranceShortcut::NoneYet => all(InsuranceStatus::NotEstablished),
        InsuranceShortcut::AllEstablishedNow | InsuranceShortcut::PerInsurer => {
            let forced = (shortcut == InsuranceShortcut::AllEstablishedNow)
                .then_some(InsuranceStatus::Established);
            let mut drafts = Vec::new();
            for insurer in Insurer::ALL {
                let found = input
                    .insurers
                    .iter()
                    .position(|i| i.insurer.as_deref().and_then(Insurer::parse) == Some(*insurer));
                match found {
                    Some(idx) => {
                        let field = format!("insurance.insurers[{idx}]");
                        if let Some(d) =
                            validate_insurer(is, &field, &input.insurers[idx], *insurer, forced)
                        {
                            drafts.push(d);
                        }
                    }
                    None => is.push(format!("insurance.insurers.{}", insurer.as_str()), REQUIRED),
                }
            }
            drafts
        }
    }
}

/// One insurer's relation. `forced` pins the status (the "all established" shortcut).
pub fn validate_insurer(
    is: &mut Issues,
    field: &str,
    input: &InsurerInput,
    insurer: Insurer,
    forced: Option<InsuranceStatus>,
) -> Option<InsuranceDraft> {
    let f = |n: &str| format!("{field}.{n}");
    let status = forced.or_else(|| {
        is.choice(
            &f("status"),
            input.status.as_deref(),
            true,
            InsuranceStatus::parse,
        )
    })?;
    let established = status == InsuranceStatus::Established;
    let mgmt_no = is.parsed(
        &f("mgmt_no"),
        input.mgmt_no.as_deref(),
        established,
        InsuranceMgmtNo::parse,
    );
    let established_on = is.date(
        &f("established_on"),
        input.established_on.as_deref(),
        established,
        None,
    );
    let unit_mode = is
        .choice(
            &f("unit_mode"),
            input.unit_mode.as_deref(),
            false,
            InsuranceUnitMode::parse,
        )
        .unwrap_or(InsuranceUnitMode::Own);
    let part_of = unit_mode == InsuranceUnitMode::PartOf;
    if part_of != input.main_workplace_id.is_some() {
        is.push(
            f("main_workplace_id"),
            if part_of { REQUIRED } else { NOT_APPLICABLE },
        );
    }
    let mut draft = InsuranceDraft::bare(insurer, status);
    draft.mgmt_no = mgmt_no;
    draft.established_on = established_on;
    draft.unit_mode = unit_mode;
    draft.main_workplace_id = input.main_workplace_id;
    let only = |is: &mut Issues, name: &str, present: bool, applies: bool| {
        if present && !applies {
            is.push(f(name), NOT_APPLICABLE);
        }
    };
    only(
        is,
        "nps_separate_application",
        input.nps_separate_application.is_some(),
        insurer == Insurer::Nps,
    );
    draft.nps_separate_application = input.nps_separate_application;
    let nhis = insurer == Insurer::Nhis;
    draft.nhis_unit_workplace_code = is.text(
        &f("nhis_unit_workplace_code"),
        input.nhis_unit_workplace_code.as_deref(),
        20,
        false,
    );
    draft.nhis_branch_office_code = is.text(
        &f("nhis_branch_office_code"),
        input.nhis_branch_office_code.as_deref(),
        20,
        false,
    );
    draft.nhis_workplace_class = is.choice(
        &f("nhis_workplace_class"),
        input.nhis_workplace_class.as_deref(),
        false,
        NhisWorkplaceClass::parse,
    );
    only(
        is,
        "nhis_workplace_class",
        draft.nhis_workplace_class.is_some()
            || draft.nhis_unit_workplace_code.is_some()
            || draft.nhis_branch_office_code.is_some(),
        nhis,
    );
    let iaci = insurer == Insurer::Iaci;
    let code = is.text(
        &f("iaci_business_type_code"),
        input.iaci_business_type_code.as_deref(),
        20,
        false,
    );
    let label = is.text(
        &f("iaci_business_type_label"),
        input.iaci_business_type_label.as_deref(),
        200,
        code.is_some(),
    );
    let year = input.iaci_insurance_year;
    if code.is_some() && year.is_none_or(|y| !(2000..=2100).contains(&y)) {
        is.push(
            f("iaci_insurance_year"),
            if year.is_none() {
                REQUIRED
            } else {
                OUT_OF_RANGE
            },
        );
    }
    draft.iaci_business_type = code.zip(label).zip(year).map(|((c, l), y)| (c, l, y));
    draft.iaci_business_form = is.choice(
        &f("iaci_business_form"),
        input.iaci_business_form.as_deref(),
        false,
        IaciBusinessForm::parse,
    );
    let fixed = draft.iaci_business_form == Some(IaciBusinessForm::FixedTerm);
    let from = is.date(
        &f("iaci_term_from"),
        input.iaci_term_from.as_deref(),
        fixed,
        None,
    );
    let to = is.date(
        &f("iaci_term_to"),
        input.iaci_term_to.as_deref(),
        fixed,
        None,
    );
    if let (Some(a), Some(b)) = (from, to)
        && b < a
    {
        is.push(f("iaci_term_to"), OUT_OF_RANGE);
    }
    draft.iaci_term = from.zip(to);
    draft.prime_contractor_mgmt_no = is.parsed(
        &f("prime_contractor_mgmt_no"),
        input.prime_contractor_mgmt_no.as_deref(),
        false,
        InsuranceMgmtNo::parse,
    );
    only(
        is,
        "iaci_business_form",
        draft.iaci_business_type.is_some()
            || draft.iaci_business_form.is_some()
            || draft.prime_contractor_mgmt_no.is_some(),
        iaci,
    );
    Some(draft)
}
