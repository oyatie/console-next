//! IMPORT-2 (decisions #25): 사번 numbering rules. A rule is a prefix and a
//! width per 사업장, 법인 or tenant (most specific first; the tenant default
//! is the registration's `E-` + 6). The next number is one past the highest
//! number of that shape in use — current numbers and live aliases alike, so
//! an old 사번 is never handed to someone else. Pure: the adapter loads the
//! rules and the numbers in use.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NumberRule {
    pub prefix: String,
    pub width: u8,
}

impl NumberRule {
    /// The registration's own scheme (`E-000001`).
    #[must_use]
    pub fn tenant_default() -> Self {
        Self {
            prefix: "E-".into(),
            width: 6,
        }
    }

    #[must_use]
    pub fn format(&self, n: u64) -> String {
        format!(
            "{}{:0width$}",
            self.prefix,
            n,
            width = usize::from(self.width)
        )
    }

    /// The sequence part of `number` when it has this rule's prefix.
    fn sequence(&self, number: &str) -> Option<u64> {
        let digits = number.strip_prefix(&self.prefix)?;
        (!digits.is_empty() && digits.len() <= 18 && digits.bytes().all(|b| b.is_ascii_digit()))
            .then(|| digits.parse().ok())
            .flatten()
    }
}

/// The rules and the numbers in use, for one plan.
#[derive(Debug, Clone, Default)]
pub struct Numbering {
    /// `import.employee_number.unnumbered` = `assign_by_rule`.
    pub assign: bool,
    pub tenant: Option<NumberRule>,
    pub by_entity: BTreeMap<Uuid, NumberRule>,
    pub by_workplace: BTreeMap<Uuid, NumberRule>,
    pub workplace_entity: BTreeMap<Uuid, Uuid>,
    /// Current 사번 of every record (voided included) and every live alias.
    pub taken: BTreeSet<String>,
}

impl Numbering {
    /// The rule for someone placed at `workplace`.
    #[must_use]
    pub fn rule_for(&self, workplace: Option<Uuid>) -> NumberRule {
        workplace
            .and_then(|w| {
                self.by_workplace.get(&w).or_else(|| {
                    self.workplace_entity
                        .get(&w)
                        .and_then(|e| self.by_entity.get(e))
                })
            })
            .or(self.tenant.as_ref())
            .cloned()
            .unwrap_or_else(NumberRule::tenant_default)
    }

    /// A free number under `rule`, marked taken.
    pub fn next(&mut self, rule: &NumberRule) -> String {
        let mut n = self
            .taken
            .iter()
            .filter_map(|number| rule.sequence(number))
            .max()
            .unwrap_or(0);
        loop {
            n += 1;
            let candidate = rule.format(n);
            if self.taken.insert(candidate.clone()) {
                return candidate;
            }
        }
    }
}

/// One line of a bulk renumbering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RenumberLine {
    pub employee_id: Uuid,
    pub from: Option<String>,
    pub to: String,
    /// `number_taken`: someone outside this line holds `to` (or held it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<&'static str>,
}

/// Old → new for `people` (`(id, current 사번)`, in the order to number them)
/// under `rule`, from 1. `taken` is every number in use (current and alias).
#[must_use]
pub fn plan_renumber(
    people: &[(Uuid, Option<String>)],
    rule: &NumberRule,
    taken: &BTreeSet<String>,
) -> Vec<RenumberLine> {
    people
        .iter()
        .zip(1u64..)
        .map(|((id, from), n)| {
            let to = rule.format(n);
            let own = from.as_deref() == Some(to.as_str());
            RenumberLine {
                employee_id: *id,
                from: from.clone(),
                conflict: (!own && taken.contains(&to)).then_some("number_taken"),
                to,
            }
        })
        .filter(|line| line.from.as_deref() != Some(line.to.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(prefix: &str, width: u8) -> NumberRule {
        NumberRule {
            prefix: prefix.into(),
            width,
        }
    }

    #[test]
    fn the_most_specific_rule_numbers_after_the_highest_in_use() {
        let (entity, workplace, other) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut n = Numbering {
            assign: true,
            by_entity: BTreeMap::from([(entity, rule("A", 4))]),
            workplace_entity: BTreeMap::from([(workplace, entity)]),
            taken: BTreeSet::from(["A0007".into(), "E-000041".into(), "A12x".into()]),
            ..Numbering::default()
        };
        let a = n.rule_for(Some(workplace));
        assert_eq!(n.next(&a), "A0008");
        assert_eq!(n.next(&a), "A0009");
        assert_eq!(n.rule_for(Some(other)), NumberRule::tenant_default());
        assert_eq!(n.next(&NumberRule::tenant_default()), "E-000042");
        n.by_workplace.insert(workplace, rule("W-", 2));
        assert_eq!(n.next(&n.rule_for(Some(workplace))), "W-01");
    }

    #[test]
    fn a_renumbering_names_its_conflicts_and_skips_who_keeps_their_number() {
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let taken = BTreeSet::from(["S-02".into(), "S-01".into(), "X".into()]);
        let lines = plan_renumber(
            &[(a, Some("S-01".into())), (b, Some("X".into())), (c, None)],
            &rule("S-", 2),
            &taken,
        );
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].employee_id, lines[0].to.as_str()), (b, "S-02"));
        assert_eq!(lines[0].conflict, Some("number_taken"));
        assert_eq!((lines[1].to.as_str(), lines[1].conflict), ("S-03", None));
    }

    #[test]
    fn property_next_never_returns_a_taken_number() {
        let mut seed = 0x1234_5678_9ABC_DEF1u64;
        for _ in 0..300 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let r = rule(
                ["E-", "A", ""][(seed % 3) as usize],
                1 + (seed >> 4) as u8 % 6,
            );
            let taken: BTreeSet<String> = (0..(seed >> 12) % 50)
                .map(|i| r.format((seed >> 20) % 97 + i * 3))
                .collect();
            let mut n = Numbering {
                taken: taken.clone(),
                ..Numbering::default()
            };
            for _ in 0..5 {
                let got = n.next(&r);
                assert!(!taken.contains(&got));
                assert!(got.starts_with(&r.prefix));
            }
        }
    }
}
