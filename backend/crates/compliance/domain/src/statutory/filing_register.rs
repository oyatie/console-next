use super::{StatutoryRegister, codes, filing, reject_overlaps};
use console_kernel_core::KernelError;
use time::Date;
impl StatutoryRegister {
    pub fn filing_rules(&self) -> &[filing::FilingRule] {
        &self.filing_rules
    }

    pub fn first_filing_date(
        &self,
        insurer: &str,
        kind: &str,
    ) -> Result<Option<Date>, KernelError> {
        self.filing_rules
            .iter()
            .filter(|r| r.insurer == insurer && r.filing_kind == kind)
            .map(|r| super::parse_date(&r.effective_from))
            .collect::<Result<Vec<_>, _>>()
            .map(|dates| dates.into_iter().min())
    }
    pub fn with_filing_rules(
        mut self,
        rules: Vec<filing::FilingRule>,
    ) -> Result<Self, KernelError> {
        let mut spans = Vec::with_capacity(rules.len().saturating_mul(2));
        for r in &rules {
            r.validate()?;
            let from = super::parse_date(&r.effective_from)?;
            let until = r
                .effective_to_exclusive
                .as_deref()
                .map(super::parse_date)
                .transpose()?;
            spans.push(((format!("code:{}", r.code), None), from, until));
            spans.push((
                (format!("duty:{}:{}", r.insurer, r.filing_kind), None),
                from,
                until,
            ));
        }
        reject_overlaps(spans.into_iter())?;
        self.filing_rules = rules;
        Ok(self)
    }
    pub fn filing_rule(
        &self,
        insurer: &str,
        kind: &str,
        on: Date,
    ) -> Result<Option<&filing::FilingRule>, KernelError> {
        for r in &self.filing_rules {
            if r.insurer == insurer && r.filing_kind == kind && r.in_force(on)? {
                return Ok(Some(r));
            }
        }
        Ok(None)
    }
    pub fn filing_rule_by_code(
        &self,
        code: &str,
        on: Date,
    ) -> Result<Option<&filing::FilingRule>, KernelError> {
        let code = codes::resolve(code);
        for r in &self.filing_rules {
            if codes::resolve(&r.code) == code && r.in_force(on)? {
                return Ok(Some(r));
            }
        }
        Ok(None)
    }
}
