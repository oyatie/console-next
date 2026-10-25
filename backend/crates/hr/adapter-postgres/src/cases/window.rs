// SPDX-License-Identifier: LicenseRef-Proprietary
//! One register window for stored case items and composer previews.
use crate::{HrError, cases::register::Register};
use console_compliance_domain::statutory::{
    StatutoryRegister,
    filing::{FilingAnchors, dates},
};
use console_hr_domain::cases::clocks::{Anchor, Anchors, Clock, DueRule, case_clocks};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::collections::BTreeMap;
use time::Date;

pub(super) struct Window {
    pub opens: Option<Date>,
    pub due: Option<Date>,
    pub disposition: &'static str,
    pub basis: Value,
}

pub(super) fn calculate(row: &PgRow, register: &StatutoryRegister) -> Result<Window, HrError> {
    let on: Date = row.try_get("effective_date")?;
    let request: Option<Date> = row.try_get("requested_on")?;
    let code: Option<String> = row.try_get("due_register_code")?;
    let mut anchors = BTreeMap::from([(Anchor::EffectiveDate, on), (Anchor::StartDate, on)]);
    if row.try_get::<String, _>("case_kind")? == "EXIT" {
        anchors.insert(Anchor::ExitDate, on);
    }
    if let Some(request) = request {
        anchors.insert(Anchor::RequestDate, request);
    }
    let rule = DueRule::parse(
        row.try_get::<Option<String>, _>("due_anchor")?.as_deref(),
        &row.try_get::<String, _>("due_rule_kind")?,
        code.as_deref(),
    )?;
    let mut opening = row.try_get::<Option<Date>, _>("fixed_opens")?;
    let template_hold = row
        .try_get::<Option<bool>, _>("recording_held")?
        .unwrap_or(row.try_get::<String, _>("release_disposition")? != "RELEASED");
    let (mut due, mut disposition, basis) = if let Some(mut filing) = code
        .as_deref()
        .map(|c| register.filing_rule_by_code(c, on))
        .transpose()?
        .flatten()
    {
        if filing.opens_anchor
            == console_compliance_domain::statutory::filing::FilingAnchor::LossDate
        {
            filing = register
                .filing_rule_by_code(&filing.code, filing.loss_on(on)?)?
                .ok_or_else(|| HrError::validation("loss rule missing"))?;
        }
        if filing.opens_anchor
            == console_compliance_domain::statutory::filing::FilingAnchor::RequestDate
            && request.is_none()
        {
            (None, "UNKNOWN", json!({"awaiting_anchor":"REQUEST_DATE"}))
        } else {
            let result = dates(
                filing,
                &FilingAnchors {
                    effective_date: Some(on),
                    acquire_date: Some(on),
                    exit_date: Some(on),
                    loss_date: Some(filing.loss_on(on)?),
                    request_date: request,
                    work_month: Some(on),
                },
                &[],
            )?;
            opening = Some(console_hr_domain::text::parse_yyyy_mm_dd(&result.opens_on)?);
            let due = result
                .due_on
                .as_deref()
                .map(console_hr_domain::text::parse_yyyy_mm_dd)
                .transpose()?;
            (
                due,
                if due.is_none() {
                    "UNKNOWN"
                } else if template_hold || register.rule(&filing.code, on)?.disposition.is_hold() {
                    "HOLD"
                } else {
                    "RELEASED"
                },
                json!({"rule":filing.code,"citation":filing.citation,"dates":result}),
            )
        }
    } else if rule.kind == console_hr_domain::cases::clocks::RuleKind::Unknown {
        (None, "UNKNOWN", json!({"unknown":true}))
    } else {
        let legacy = Register(register.clone());
        let clock = case_clocks(
            std::slice::from_ref(&rule),
            &Anchors(anchors.clone()),
            &legacy,
        )
        .pop()
        .unwrap_or(Clock::Unknown);
        match clock {
            Clock::Due { date, held } => {
                opening = if let Some(offset) =
                    row.try_get::<Option<i32>, _>("case_opens_offset_days")?
                {
                    rule.anchor
                        .and_then(|a| anchors.get(&a).copied())
                        .and_then(|on| on.checked_add(time::Duration::days(offset.into())))
                } else if !row.try_get::<bool, _>("legal")? {
                    opening.or_else(|| rule.anchor.and_then(|a| anchors.get(&a).copied()))
                } else {
                    None
                };
                (
                    Some(date),
                    if held || template_hold {
                        "HOLD"
                    } else {
                        "RELEASED"
                    },
                    json!({"register_code":code}),
                )
            }
            Clock::WithoutDelay { since } => {
                opening = Some(since);
                (
                    None,
                    "HOLD",
                    json!({"without_delay_since":since.to_string()}),
                )
            }
            _ => (None, "UNKNOWN", json!({"unknown":true})),
        }
    };
    if row.try_get::<bool, _>("legal")? && code.is_none() {
        due = None;
        disposition = "UNKNOWN";
        opening = None;
    }
    if row.try_get::<String, _>("kind")? == "FIL"
        && due.is_some_and(|due| due < row.get::<Date, _>("go_live_on"))
    {
        opening = None;
        due = None;
        disposition = "PRE_CONSOLE";
    }
    Ok(Window {
        opens: opening,
        due,
        disposition,
        basis,
    })
}
