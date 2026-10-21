use time::macros::{date, datetime};
use uuid::Uuid;

use super::{LockWindow, MonthClose, MonthState, month_state, strictest};

const SEP: time::Date = date!(2026 - 09 - 01);
const B1: Uuid = Uuid::from_u128(1);
const B2: Uuid = Uuid::from_u128(2);
const L1: Uuid = Uuid::from_u128(11);
const L2: Uuid = Uuid::from_u128(12);
const AT: time::OffsetDateTime = datetime!(2026-10-20 09:00 UTC);

fn org() -> MonthClose {
    MonthClose {
        month: SEP,
        branch: None,
    }
}

fn branch(b: Uuid) -> MonthClose {
    MonthClose {
        month: SEP,
        branch: Some(b),
    }
}

fn window(id: Uuid, start: time::Date, end: time::Date, in_force: bool) -> LockWindow {
    LockWindow {
        lock_id: id,
        start,
        end,
        in_force,
        relock_at: (!in_force).then_some(AT),
    }
}

fn sep(in_force: bool) -> LockWindow {
    window(L1, SEP, date!(2026 - 09 - 30), in_force)
}

type Case = (
    &'static str,
    Vec<MonthClose>,
    Vec<LockWindow>,
    Option<Uuid>,
    MonthState,
);

#[test]
fn the_month_state_table() {
    let closed = |lock_id| MonthState::Closed { lock_id };
    let reopened = MonthState::Reopened {
        lock_id: L1,
        relock_at: Some(AT),
    };
    let cases: Vec<Case> = vec![
        (
            "no close",
            vec![],
            vec![sep(true)],
            Some(B1),
            MonthState::Open,
        ),
        (
            "another month's close",
            vec![MonthClose {
                month: date!(2026 - 08 - 01),
                branch: None,
            }],
            vec![],
            Some(B1),
            MonthState::Open,
        ),
        (
            "another branch's close",
            vec![branch(B2)],
            vec![],
            Some(B1),
            MonthState::Open,
        ),
        (
            "org close, lock in force",
            vec![org()],
            vec![sep(true)],
            Some(B1),
            closed(Some(L1)),
        ),
        (
            "org close reaches a branchless person",
            vec![org()],
            vec![sep(true)],
            None,
            closed(Some(L1)),
        ),
        (
            "branch close, no lock",
            vec![branch(B1)],
            vec![],
            Some(B1),
            closed(None),
        ),
        (
            "org close, unlock open",
            vec![org()],
            vec![sep(false)],
            Some(B1),
            reopened,
        ),
        (
            "branch close reopened by the org unlock",
            vec![branch(B1)],
            vec![sep(false)],
            Some(B1),
            reopened,
        ),
        (
            "another lock in force over part of the month",
            vec![org()],
            vec![
                sep(false),
                window(L2, date!(2026 - 09 - 15), date!(2026 - 10 - 15), true),
            ],
            Some(B1),
            closed(Some(L2)),
        ),
        (
            "a lock in force over another month leaves the reopen alone",
            vec![org()],
            vec![
                sep(false),
                window(L2, date!(2026 - 10 - 01), date!(2026 - 10 - 31), true),
            ],
            Some(B1),
            reopened,
        ),
        (
            "an unlock over half the month does not reopen it",
            vec![org()],
            vec![window(
                L2,
                date!(2026 - 09 - 15),
                date!(2026 - 09 - 30),
                false,
            )],
            Some(B1),
            closed(None),
        ),
        (
            "a quarter unlock reopens the month",
            vec![org()],
            vec![window(
                L2,
                date!(2026 - 07 - 01),
                date!(2026 - 09 - 30),
                false,
            )],
            Some(B1),
            MonthState::Reopened {
                lock_id: L2,
                relock_at: Some(AT),
            },
        ),
    ];
    for (name, closes, windows, b, want) in cases {
        assert_eq!(
            month_state(date!(2026 - 09 - 17), b, &closes, &windows),
            want,
            "{name}"
        );
    }
}

#[test]
fn the_earliest_relock_wins_and_an_untimed_unlock_comes_last() {
    let mut late = sep(false);
    late.relock_at = Some(datetime!(2026-10-30 09:00 UTC));
    let mut untimed = window(L2, SEP, date!(2026 - 09 - 30), false);
    untimed.relock_at = None;
    let mut early = window(Uuid::from_u128(13), SEP, date!(2026 - 09 - 30), false);
    early.relock_at = Some(AT);
    assert_eq!(
        month_state(SEP, None, &[org()], &[late, untimed, early]),
        MonthState::Reopened {
            lock_id: early.lock_id,
            relock_at: Some(AT)
        }
    );
    assert_eq!(
        month_state(SEP, None, &[org()], &[untimed]),
        MonthState::Reopened {
            lock_id: L2,
            relock_at: None
        }
    );
}

#[test]
fn strictest_is_closed_anywhere_then_reopened_then_open() {
    let closes = [branch(B1)];
    assert_eq!(
        strictest(SEP, &[Some(B2), Some(B1)], &closes, &[]),
        MonthState::Closed { lock_id: None }
    );
    assert_eq!(strictest(SEP, &[Some(B2)], &closes, &[]), MonthState::Open);
    assert_eq!(
        strictest(SEP, &[], &[org()], &[sep(true)]),
        MonthState::Closed { lock_id: Some(L1) },
        "no branch: only the org close reaches it"
    );
    assert_eq!(strictest(SEP, &[], &closes, &[]), MonthState::Open);
    assert!(
        strictest(SEP, &[Some(B1), Some(B2)], &closes, &[sep(false)]).takes_writes(),
        "reopened takes writes"
    );
}

#[test]
fn only_closed_refuses_writes() {
    assert_eq!(
        [
            MonthState::Open.as_str(),
            MonthState::Closed { lock_id: None }.as_str(),
            MonthState::Reopened {
                lock_id: L1,
                relock_at: None
            }
            .as_str()
        ],
        ["open", "closed", "reopened"],
        "the metric label of each state"
    );
    assert!(MonthState::Open.takes_writes());
    assert!(!MonthState::Closed { lock_id: None }.takes_writes());
    assert!(
        MonthState::Reopened {
            lock_id: L1,
            relock_at: None
        }
        .takes_writes()
    );
}
