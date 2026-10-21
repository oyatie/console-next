//! EMP-CREATE (pre-alpha gate U8): the EMP-MODEL facts a registration records
//! with the employee, in the same transaction, so `POST /api/v1/employees`
//! makes any of the nine employment types with its facts in one call
//! (parity E3, E4, E5, E12, E13, G1). Every field is optional; an absent one
//! is recorded later through the facts PATCH or the contract endpoint.

use console_hr_domain::contract::{ContractKind, ContractTerms, validate_terms};
use console_hr_domain::profile::enums::{EmploymentType, IdType, PayUnit};
use console_hr_domain::profile::facts::{
    normalize_work_email, validate_birth_date, validate_probation_end,
};
use console_hr_domain::profile::registration::{
    below_minimum_wage, check_contract_kind, check_probation_applies,
};
use console_hr_domain::text::{normalize_optional_text, parse_yyyy_mm_dd};
use console_ontology_canonical_adapter_postgres::employee_facts::{
    EmployeePersonFacts, set_employee_person_facts,
};
use serde::{Deserialize, Serialize};
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::contract::insert_row;
use crate::directory::types::EmployeeCreateWarning;
use crate::profile::minimum_wage_hint;

/// The first contract given with a registration. Omitted terms default from
/// the registration: start = `hire_date`, wage and unit = `base_pay_won` and
/// `pay_unit` (a non-labour contract with no wage records 0).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateEmployeeContract {
    pub kind: String,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub wage_won: Option<i64>,
    #[serde(default)]
    pub pay_unit: Option<String>,
    #[serde(default)]
    pub weekly_minutes: Option<i32>,
}

/// The raw EMP-MODEL fields of a registration, as the request carries them.
#[derive(Debug, Default)]
pub struct RawEmployeeFacts {
    pub work_email: Option<String>,
    pub birth_date: Option<String>,
    pub id_type: Option<String>,
    pub base_pay_won: Option<i64>,
    pub pay_unit: Option<String>,
    pub probation_end_date: Option<String>,
    pub contract: Option<CreateEmployeeContract>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedContract {
    pub kind: ContractKind,
    pub start_date: String,
    pub end_date: Option<String>,
    pub wage_won: i64,
    pub pay_unit: PayUnit,
    pub weekly_minutes: Option<i32>,
}

/// Every field is skipped when absent, so a registration without EMP-MODEL
/// facts hashes exactly as before (stored idempotency reservations hold).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NormalizedEmployeeFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birth_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_type: Option<IdType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_pay_won: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pay_unit: Option<PayUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probation_end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<NormalizedContract>,
}

impl NormalizedEmployeeFacts {
    fn person_given(&self) -> bool {
        self.work_email.is_some() || self.birth_date.is_some() || self.id_type.is_some()
    }

    fn profile_given(&self) -> bool {
        self.base_pay_won.is_some() || self.probation_end_date.is_some()
    }
}

fn optional_date(value: Option<String>) -> Result<Option<Date>, HrError> {
    Ok(normalize_optional_text(value)
        .map(|raw| parse_yyyy_mm_dd(&raw))
        .transpose()?)
}

fn normalize_contract(
    raw: CreateEmployeeContract,
    employment_type: EmploymentType,
    hire_date: Option<Date>,
    pay: Option<(i64, PayUnit)>,
) -> Result<NormalizedContract, HrError> {
    let kind = ContractKind::parse(raw.kind.trim())?;
    check_contract_kind(employment_type, kind)?;
    let start_date = optional_date(raw.start_date)?
        .or(hire_date)
        .ok_or_else(|| HrError::validation("contract.start_date is required"))?;
    let pay_unit = match normalize_optional_text(raw.pay_unit) {
        Some(unit) => PayUnit::parse(&unit)?,
        None => pay
            .map(|(_, unit)| unit)
            .ok_or_else(|| HrError::validation("contract.pay_unit is required"))?,
    };
    let terms = ContractTerms {
        kind,
        start_date,
        end_date: optional_date(raw.end_date)?,
        wage_won: raw.wage_won.or(pay.map(|(won, _)| won)).unwrap_or(0),
        pay_unit,
        weekly_minutes: raw.weekly_minutes,
    };
    validate_terms(&terms)?;
    Ok(NormalizedContract {
        kind,
        start_date: start_date.to_string(),
        end_date: terms.end_date.map(|date| date.to_string()),
        wage_won: terms.wage_won,
        pay_unit,
        weekly_minutes: terms.weekly_minutes,
    })
}

/// # Errors
/// Validation naming the first fact that cannot be recorded.
pub fn normalize_employee_facts(
    raw: RawEmployeeFacts,
    employment_type: Option<EmploymentType>,
    hire_date: Option<Date>,
) -> Result<NormalizedEmployeeFacts, HrError> {
    let work_email = normalize_optional_text(raw.work_email)
        .map(|email| normalize_work_email(&email))
        .transpose()?;
    let birth_date = optional_date(raw.birth_date)?;
    if let Some(birth) = birth_date {
        validate_birth_date(birth, today_kst())?;
    }
    let id_type = normalize_optional_text(raw.id_type)
        .map(|value| IdType::parse(&value))
        .transpose()?;
    let pay_unit = normalize_optional_text(raw.pay_unit)
        .map(|value| PayUnit::parse(&value))
        .transpose()?;
    let pay = match (raw.base_pay_won, pay_unit) {
        (Some(won), Some(_)) if won < 0 => {
            return Err(HrError::validation(
                "base_pay_won must be a whole number of won, 0 or more",
            ));
        }
        (Some(won), Some(unit)) => Some((won, unit)),
        (None, None) => None,
        _ => {
            return Err(HrError::validation(
                "base_pay_won and pay_unit are given together",
            ));
        }
    };
    let probation_end_date = optional_date(raw.probation_end_date)?;
    if let Some(end) = probation_end_date {
        check_probation_applies(
            employment_type
                .ok_or_else(|| HrError::validation("employment_type is required for probation"))?,
        )?;
        validate_probation_end(end, hire_date, false)?;
    }
    let contract = raw
        .contract
        .map(|contract| {
            normalize_contract(
                contract,
                employment_type.ok_or_else(|| {
                    HrError::validation("employment_type is required for contract")
                })?,
                hire_date,
                pay,
            )
        })
        .transpose()?;
    Ok(NormalizedEmployeeFacts {
        work_email,
        birth_date: birth_date.map(|date| date.to_string()),
        id_type,
        base_pay_won: pay.map(|(won, _)| won),
        pay_unit: pay.map(|(_, unit)| unit),
        probation_end_date: probation_end_date.map(|date| date.to_string()),
        contract,
    })
}

/// Writes the facts for the employee the same transaction just created: the
/// person facts on the head (through its owner), pay and probation on the
/// profile, and the first contract row.
pub async fn record_registration_facts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    actor: Uuid,
    facts: &NormalizedEmployeeFacts,
) -> Result<(), HrError> {
    if facts.person_given() {
        set_employee_person_facts(
            tx,
            org_id,
            employee_id,
            EmployeePersonFacts {
                birth_date: optional_date(facts.birth_date.clone())?,
                work_email: facts.work_email.as_deref(),
                id_type: facts.id_type.map(IdType::as_str),
            },
        )
        .await?;
    }
    if facts.profile_given() {
        sqlx::query(
            "UPDATE employee_employment_profiles SET base_pay_won = $3, pay_unit = $4, \
             probation_end_date = $5::DATE WHERE org_id = $1 AND employee_id = $2",
        )
        .bind(org_id)
        .bind(employee_id)
        .bind(facts.base_pay_won)
        .bind(facts.pay_unit.map(PayUnit::as_str))
        .bind(facts.probation_end_date.as_deref())
        .execute(tx.as_mut())
        .await?;
    }
    if let Some(contract) = &facts.contract {
        let terms = ContractTerms {
            kind: contract.kind,
            start_date: parse_yyyy_mm_dd(&contract.start_date)?,
            end_date: optional_date(contract.end_date.clone())?,
            wage_won: contract.wage_won,
            pay_unit: contract.pay_unit,
            weekly_minutes: contract.weekly_minutes,
        };
        // A registration is replayed through its own idempotency row, never
        // here, so the contract's command id only has to be unique.
        insert_row(tx, org_id, employee_id, Uuid::new_v4(), &terms, None, actor).await?;
    }
    Ok(())
}

/// `pay_below_minimum_wage`: the recorded pay (or the contract wage) of a
/// 근로자 is below the 최저임금 floor in force on the hire date. A hint, never
/// a refusal: the payslip's own check is the binding one.
#[must_use]
pub fn minimum_wage_warning(
    employment_type: EmploymentType,
    facts: &NormalizedEmployeeFacts,
    hire_date: Option<Date>,
) -> Option<EmployeeCreateWarning> {
    let weekly = facts.contract.as_ref().and_then(|c| c.weekly_minutes);
    let (wage, unit) = match (facts.base_pay_won, facts.pay_unit, &facts.contract) {
        (Some(won), Some(unit), _) => (won, unit),
        (_, _, Some(contract)) => (contract.wage_won, contract.pay_unit),
        _ => return None,
    };
    wage_warning(
        employment_type,
        wage,
        unit,
        weekly,
        hire_date.unwrap_or_else(today_kst),
    )
}

pub(super) fn wage_warning(
    employment_type: EmploymentType,
    wage: i64,
    unit: PayUnit,
    weekly: Option<i32>,
    on: Date,
) -> Option<EmployeeCreateWarning> {
    let hint = minimum_wage_hint(on, unit, weekly)?;
    below_minimum_wage(employment_type, wage, hint.floor_won).then(|| EmployeeCreateWarning {
        code: "pay_below_minimum_wage",
        employee_ids: Vec::new(),
        floor_won: hint.floor_won,
    })
}
