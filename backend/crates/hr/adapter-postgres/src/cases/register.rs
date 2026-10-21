//! The statutory register (compliance) as `case_clocks` reads it. The register
//! resolves SF's `ins.deadline.*` keys to their bw30 rows itself.

use console_compliance_domain::statutory::{StatutoryRegister, StatutoryUnit};
use console_hr_domain::cases::clocks::{
    Anchor, Anchors, Clock, DueRegister, RegisterUnit, RegisterValue,
};
use console_kernel_core::KernelError;
use time::Date;

pub(crate) struct Register(pub(crate) StatutoryRegister);

impl DueRegister for Register {
    fn filing_clock(&self, code: &str, anchors: &Anchors) -> Result<Option<Clock>, KernelError> {
        let Some(on) = anchors
            .0
            .get(&Anchor::EffectiveDate)
            .or_else(|| anchors.0.get(&Anchor::ExitDate))
            .copied()
        else {
            return Ok(None);
        };
        let Some(mut rule) = self.0.filing_rule_by_code(code, on)? else {
            return Ok(None);
        };
        if rule.opens_anchor == console_compliance_domain::statutory::filing::FilingAnchor::LossDate
        {
            rule = self
                .0
                .filing_rule_by_code(code, rule.loss_on(on)?)?
                .ok_or_else(|| KernelError::validation("loss rule missing"))?;
        }
        if rule.deadline.anchor
            == console_compliance_domain::statutory::filing::FilingAnchor::RequestDate
            && !anchors.0.contains_key(&Anchor::RequestDate)
        {
            return Ok(Some(Clock::AwaitingAnchor(Anchor::RequestDate)));
        }
        let dates = console_compliance_domain::statutory::filing::dates(
            rule,
            &console_compliance_domain::statutory::filing::FilingAnchors {
                effective_date: Some(on),
                acquire_date: Some(on),
                exit_date: Some(on),
                loss_date: Some(rule.loss_on(on)?),
                request_date: anchors.0.get(&Anchor::RequestDate).copied(),
                work_month: Some(on),
            },
            &[],
        )?;
        Ok(Some(if let Some(d) = dates.due_on {
            Clock::Due {
                date: console_hr_domain::text::parse_yyyy_mm_dd(&d)?,
                held: self
                    .0
                    .rule(
                        &rule.code,
                        console_hr_domain::text::parse_yyyy_mm_dd(&rule.effective_from)?,
                    )?
                    .disposition
                    .is_hold(),
            }
        } else if dates.without_delay {
            Clock::WithoutDelay {
                since: anchors.0.get(&Anchor::RequestDate).copied().unwrap_or(on),
            }
        } else {
            Clock::Unknown
        }))
    }
    fn value(&self, code: &str, on: Date) -> Result<RegisterValue, KernelError> {
        let rule = self.0.rule(code, on)?;
        let unit = match rule.unit {
            StatutoryUnit::Days => RegisterUnit::Days,
            StatutoryUnit::Months => RegisterUnit::Months,
            StatutoryUnit::DayOfNextMonth => RegisterUnit::DayOfNextMonth,
            other => {
                return Err(KernelError::validation(format!(
                    "statutory rule {code} is in {other:?}, which no due rule counts"
                )));
            }
        };
        let value = u16::try_from(rule.whole(rule.unit)?).map_err(|_| {
            KernelError::validation(format!("statutory rule {code} is out of range"))
        })?;
        Ok(RegisterValue {
            unit,
            value,
            held: rule.disposition.is_hold(),
        })
    }
}
