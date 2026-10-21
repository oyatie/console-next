use super::{Applicability, Exclusion, FilingFacts, applicability};
use console_kernel_core::KernelError;
/// Exclusions may use distinct anchors (prior membership versus an already elapsed age loss).
pub fn applies(
    rule: &super::FilingRule,
    anchors: &super::FilingAnchors,
    facts: &FilingFacts,
) -> Result<Applicability, KernelError> {
    facts.validate()?;
    if rule.applicability_unverified {
        return Ok(Applicability::Unknown {
            missing: vec!["historic_applicability"],
        });
    }
    let default = anchors
        .get(rule.applicability_anchor.unwrap_or(rule.opens_anchor))
        .ok_or_else(|| KernelError::validation("coverage anchor missing"))?;
    let mut missing = Vec::new();
    if rule.daily_required {
        match facts.daily {
            Some(false) => {
                return Ok(Applicability::NotApplicable {
                    reason: super::Reason::OtherLegalGround,
                });
            }
            None => missing.push("daily"),
            Some(true) => (),
        }
    }
    for exclusion in &rule.exclusions {
        let on = if matches!(exclusion, Exclusion::AgeLimit { .. }) {
            rule.age_limit_anchor
                .and_then(|a| anchors.get(a))
                .unwrap_or(default)
                .checked_add(time::Duration::days(rule.age_limit_offset.into()))
                .ok_or_else(|| KernelError::validation("coverage anchor outside calendar"))?
        } else {
            default
        };
        match applicability(std::slice::from_ref(exclusion), facts, on)? {
            a @ Applicability::NotApplicable { .. } => return Ok(a),
            Applicability::Unknown { missing: m } => missing.extend(m),
            Applicability::Applies => (),
        }
    }
    missing.sort_unstable();
    missing.dedup();
    Ok(if missing.is_empty() {
        Applicability::Applies
    } else {
        Applicability::Unknown { missing }
    })
}
