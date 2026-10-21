//! E10: the onboarding checklist, derived from recorded facts only. There is
//! no tick: an item is done when the fact it names is on the record
//! (decisions #3). Offline facts the console cannot observe yet are listed as
//! `NOT_TRACKED`, never as done, so nobody mistakes silence for completion.

use serde::Serialize;
use time::{Date, Duration};

use crate::profile::enums::IdType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChecklistItem {
    /// A contract row covering the hire date (G1).
    ContractRecorded,
    /// 근로계약서 서면 교부 (근기법 §17②): an offline fact, attested through
    /// BW-06 (decisions #3).
    ContractDelivered,
    /// 신분증명 종류 (E4). NOT_ISSUED opens a follow-up instead of blocking.
    IdRegistered,
    /// 생년월일 (E4; 근기법 시행령 §20 명부 기재사항).
    BirthDateRecorded,
    /// 기본급 단위와 원 단위 금액 (E5).
    PayRecorded,
    /// 4대보험 취득신고: an offline filing with a statutory clock.
    /// NOT_TRACKED until a filing record exists and the per-scheme
    /// deadlines (they differ between 국민연금, 건강보험 and 고용·산재) are
    /// statutory register rows with their citations. Then it becomes Done/Open
    /// with a server-clock due date; never a hard-coded day count here.
    InsuranceAcquisitionReported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ItemState {
    Done,
    Open,
    /// Recorded as not yet available (NOT_ISSUED): a dated follow-up.
    FollowUp,
    /// The console does not observe this fact yet.
    NotTracked,
}

/// The recorded facts the checklist reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnboardingFacts {
    pub hire_date: Option<Date>,
    pub id_type: Option<IdType>,
    pub birth_date_recorded: bool,
    pub pay_recorded: bool,
    /// A live contract covers the hire date (or, with no hire date, any live
    /// contract exists).
    pub contract_covers_hire: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChecklistEntry {
    pub item: ChecklistItem,
    pub state: ItemState,
}

fn done_if(recorded: bool) -> ItemState {
    if recorded {
        ItemState::Done
    } else {
        ItemState::Open
    }
}

/// Every item, in display order, with its state.
#[must_use]
pub fn onboarding_checklist(facts: &OnboardingFacts) -> Vec<ChecklistEntry> {
    let id_state = match facts.id_type {
        None => ItemState::Open,
        Some(IdType::NotIssued) => ItemState::FollowUp,
        Some(_) => ItemState::Done,
    };
    [
        (
            ChecklistItem::ContractRecorded,
            done_if(facts.contract_covers_hire),
        ),
        (ChecklistItem::ContractDelivered, ItemState::NotTracked),
        (ChecklistItem::IdRegistered, id_state),
        (
            ChecklistItem::BirthDateRecorded,
            done_if(facts.birth_date_recorded),
        ),
        (ChecklistItem::PayRecorded, done_if(facts.pay_recorded)),
        (
            ChecklistItem::InsuranceAcquisitionReported,
            ItemState::NotTracked,
        ),
    ]
    .map(|(item, state)| ChecklistEntry { item, state })
    .to_vec()
}

/// Inside the onboarding window with something left to do: the person shows
/// in the 온보딩 queue. Past the window the open items stay listed but the
/// person leaves the queue. `window_days` is a settings value.
#[must_use]
pub fn onboarding_pending(
    entries: &[ChecklistEntry],
    hire_date: Option<Date>,
    today: Date,
    window_days: u16,
) -> bool {
    hire_date.is_some_and(|hire| today <= hire + Duration::days(i64::from(window_days)))
        && entries
            .iter()
            .any(|entry| matches!(entry.state, ItemState::Open | ItemState::FollowUp))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn facts() -> OnboardingFacts {
        OnboardingFacts {
            hire_date: Some(date!(2026 - 10 - 01)),
            id_type: Some(IdType::Rrn),
            birth_date_recorded: true,
            pay_recorded: true,
            contract_covers_hire: true,
        }
    }

    fn state(list: &[ChecklistEntry], item: ChecklistItem) -> ItemState {
        list.iter()
            .find(|e| e.item == item)
            .map(|e| e.state)
            .unwrap()
    }

    fn pending(facts: &OnboardingFacts, today: Date) -> bool {
        onboarding_pending(&onboarding_checklist(facts), facts.hire_date, today, 30)
    }

    #[test]
    fn complete_facts_leave_only_untracked_items_and_no_queue() {
        let list = onboarding_checklist(&facts());
        assert!(!pending(&facts(), date!(2026 - 10 - 03)));
        assert!(
            list.iter()
                .all(|e| matches!(e.state, ItemState::Done | ItemState::NotTracked))
        );
        assert_eq!(
            state(&list, ChecklistItem::InsuranceAcquisitionReported),
            ItemState::NotTracked
        );
    }

    #[test]
    fn not_issued_id_is_a_follow_up_and_keeps_the_person_queued() {
        let not_issued = OnboardingFacts {
            id_type: Some(IdType::NotIssued),
            ..facts()
        };
        let list = onboarding_checklist(&not_issued);
        assert_eq!(
            state(&list, ChecklistItem::IdRegistered),
            ItemState::FollowUp
        );
        assert!(pending(&not_issued, date!(2026 - 10 - 03)));
    }

    #[test]
    fn the_window_ends_the_queue_not_the_items() {
        let missing = OnboardingFacts {
            contract_covers_hire: false,
            ..facts()
        };
        assert!(pending(&missing, date!(2026 - 10 - 31)));
        assert!(!pending(&missing, date!(2026 - 11 - 01)));
        assert_eq!(
            state(
                &onboarding_checklist(&missing),
                ChecklistItem::ContractRecorded
            ),
            ItemState::Open
        );
        let no_hire = OnboardingFacts {
            hire_date: None,
            ..missing
        };
        assert!(!pending(&no_hire, date!(2026 - 10 - 03)));
    }
}
