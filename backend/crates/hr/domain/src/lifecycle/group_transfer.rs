//! Group transfer continuity (design/inter-entity-transfer.md T2, F3–F10):
//! severance pay, annual leave and length of service are each chosen, none
//! defaulted. SETTLED is the legal outcome when nothing is agreed (F3), but it
//! is still a choice the employee and the two legal entities make; CARRIED
//! rests on a special agreement or the receiving legal entity's rules of
//! employment, so it needs that agreement's evidence. Whether a mix is lawful
//! (N-LC1, N-LC2) is for the labor attorney: the choice is recorded, never
//! inferred.

use console_kernel_core::KernelError;

/// Severance pay or annual leave: settled at the sending legal entity, or
/// carried to the receiving one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    Settled,
    Carried,
}

/// Length of service: counted afresh from the start date, or carried from the
/// group hire date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seniority {
    Restart,
    Carried,
}

impl Settle {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "SETTLED",
            Self::Carried => "CARRIED",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "SETTLED" => Some(Self::Settled),
            "CARRIED" => Some(Self::Carried),
            _ => None,
        }
    }
}

impl Seniority {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Restart => "RESTART",
            Self::Carried => "CARRIED",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "RESTART" => Some(Self::Restart),
            "CARRIED" => Some(Self::Carried),
            _ => None,
        }
    }
}

/// The three choices of one group transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Continuity {
    pub severance: Settle,
    pub annual_leave: Settle,
    pub seniority: Seniority,
}

fn required(field: &str, allowed: &str) -> KernelError {
    KernelError::validation(format!(
        "group_transfer.{field} is required: {allowed} (there is no default)"
    ))
}

fn trimmed(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|v| !v.is_empty())
}

impl Continuity {
    /// The three choices as sent. `severance` is the `continuity` field. A body
    /// with neither of the other two is the one-choice contract every group
    /// transfer before T2 used: its single choice named all three (SETTLED
    /// settled severance pay and annual leave and restarted length of service),
    /// so it still means that. A body naming either names both.
    ///
    /// # Errors
    /// 422 `validation` naming the missing or unknown dimension.
    pub fn parse(
        severance: Option<&str>,
        annual_leave: Option<&str>,
        seniority: Option<&str>,
    ) -> Result<Self, KernelError> {
        let severance = trimmed(severance)
            .and_then(Settle::parse)
            .ok_or_else(|| required("continuity", "SETTLED or CARRIED"))?;
        let (annual_leave, seniority) = match (trimmed(annual_leave), trimmed(seniority)) {
            (None, None) => (
                severance,
                match severance {
                    Settle::Settled => Seniority::Restart,
                    Settle::Carried => Seniority::Carried,
                },
            ),
            (a, s) => (
                a.and_then(Settle::parse)
                    .ok_or_else(|| required("annual_leave_continuity", "SETTLED or CARRIED"))?,
                s.and_then(Seniority::parse)
                    .ok_or_else(|| required("seniority_continuity", "RESTART or CARRIED"))?,
            ),
        };
        Ok(Self {
            severance,
            annual_leave,
            seniority,
        })
    }

    /// Any dimension carried rests on the succession agreement (F3, F4).
    #[must_use]
    pub fn needs_succession_evidence(self) -> bool {
        self.severance == Settle::Carried
            || self.annual_leave == Settle::Carried
            || self.seniority == Seniority::Carried
    }

    /// The sending legal entity pays severance pay (Employee Retirement Benefit
    /// Security Act Article 9) and settles every item of money and valuables
    /// (Labor Standards Act Article 36): its settlement case opens with the
    /// group transfer. Under severance succession the relationship carries over
    /// (F4) and paying it would contradict the choice (F5), so no case opens;
    /// the mixes are N-LC1.
    #[must_use]
    pub fn opens_settlement_case(self) -> bool {
        self.severance == Settle::Settled
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    type Sent<'a> = (Option<&'a str>, Option<&'a str>, Option<&'a str>);
    type Chosen = Option<(Settle, Settle, Seniority)>;

    #[test]
    fn every_dimension_is_chosen_and_the_one_choice_contract_keeps_its_meaning() {
        let (s, c) = (Some("SETTLED"), Some("CARRIED"));
        let (settled, carried, restart) = (Settle::Settled, Settle::Carried, Seniority::Restart);
        let cases: [(Sent, Chosen); 9] = [
            ((s, None, None), Some((settled, settled, restart))),
            (
                (c, None, None),
                Some((carried, carried, Seniority::Carried)),
            ),
            ((s, c, c), Some((settled, carried, Seniority::Carried))),
            (
                (Some(" CARRIED "), s, Some("RESTART")),
                Some((carried, settled, restart)),
            ),
            ((None, s, Some("RESTART")), None),
            ((s, s, None), None),
            ((s, None, Some("RESTART")), None),
            ((s, s, s), None),
            ((Some("PAID"), None, None), None),
        ];
        for ((severance, annual, seniority), want) in cases {
            let got = Continuity::parse(severance, annual, seniority).ok();
            let got = got.map(|c| (c.severance, c.annual_leave, c.seniority));
            assert_eq!(got, want, "{severance:?} {annual:?} {seniority:?}");
        }
    }

    #[test]
    fn each_choice_is_stored_by_its_own_code() {
        let codes = [
            Settle::Settled.as_str(),
            Settle::Carried.as_str(),
            Seniority::Restart.as_str(),
            Seniority::Carried.as_str(),
        ];
        assert_eq!(codes, ["SETTLED", "CARRIED", "RESTART", "CARRIED"]);
    }

    #[test]
    fn evidence_follows_any_carried_dimension_and_only_settled_severance_opens_a_case() {
        let c = |s, a, n| Continuity::parse(Some(s), Some(a), Some(n)).unwrap();
        assert!(!c("SETTLED", "SETTLED", "RESTART").needs_succession_evidence());
        assert!(c("SETTLED", "SETTLED", "CARRIED").needs_succession_evidence());
        assert!(c("SETTLED", "CARRIED", "RESTART").needs_succession_evidence());
        assert!(c("CARRIED", "SETTLED", "RESTART").needs_succession_evidence());
        assert!(c("SETTLED", "CARRIED", "CARRIED").opens_settlement_case());
        assert!(!c("CARRIED", "SETTLED", "RESTART").opens_settlement_case());
    }
}
