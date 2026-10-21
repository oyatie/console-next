//! 전적 continuity (design/inter-entity-transfer.md T2, F3–F10): 퇴직금, 연차
//! and 근속 are each chosen, none defaulted. SETTLED is the legal outcome when
//! nothing is agreed (F3), but it is still a choice the employee and the two
//! 법인 make; CARRIED rests on a 특약 or the receiving 법인's 취업규칙, so it
//! needs that agreement's evidence. Whether a mix is lawful (N-LC1, N-LC2) is
//! for the 노무사: the choice is recorded, never inferred.

use console_kernel_core::KernelError;

/// 퇴직금 or 연차: settled at the sending 법인, or carried to the receiving one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    Settled,
    Carried,
}

/// 근속: counted afresh from the start date, or carried from the 그룹 입사일.
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

/// The three choices of one 전적.
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
    /// with neither of the other two is the one-choice contract every 전적
    /// before T2 used: its single choice named all three (SETTLED settled
    /// 퇴직금 and 연차 and restarted 근속), so it still means that. A body
    /// naming either names both.
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

    /// The sending 법인 pays 퇴직금 (「근로자퇴직급여 보장법」 제9조) and settles
    /// every 금품 (「근로기준법」 제36조): its settlement case opens with the
    /// 전적. Under 퇴직금 승계 the relationship carries over (F4) and paying it
    /// would contradict the choice (F5), so no case opens; the mixes are N-LC1.
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
