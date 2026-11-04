// SPDX-License-Identifier: LicenseRef-Proprietary
//! Oldest issue in the board's calendar month, using the same dated placement and recognition.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use console_attendance_application::records_read::{EntryRead, IssueGroup};
use console_attendance_domain::records::{EntryKind, Mark};
use time::{Date, Duration};
use uuid::Uuid;

use super::{day::evaluate_day, roster::Member, thresholds::RecordSettings};
use crate::schedule::{ScheduleStoreError, org::Person, universe::Universe};

pub(super) fn earliest(
    u: &Universe,
    settings: &RecordSettings,
    members: &[Member],
    entries: &HashMap<(Uuid, Date), EntryRead>,
    today: Date,
    permitted: impl Fn(&Person) -> Result<bool, ScheduleStoreError>,
    issues: &mut BTreeMap<Mark, IssueGroup>,
) -> Result<(), ScheduleStoreError> {
    let Some(date) = issues.values().next().map(|g| g.earliest_date) else {
        return Ok(());
    };
    let mut remaining: BTreeSet<_> = issues.keys().copied().collect();
    let mut day = date
        .replace_day(1)
        .map_err(|_| ScheduleStoreError::Corrupt("board month"))?;
    while day < date && !remaining.is_empty() {
        for p in members.iter().filter_map(|m| m.on(day)) {
            if !permitted(&p)? {
                continue;
            }
            let entry = entries.get(&(p.id, day));
            if entry.is_some_and(|entry| entry.kind == EntryKind::ClockInOnly)
                && remaining.remove(&Mark::MissingOut)
                && let Some(group) = issues.get_mut(&Mark::MissingOut)
            {
                group.earliest_date = day;
            }
            if remaining.is_empty() {
                break;
            }
            // Missing-out is entry-shaped; recognition cannot add it.
            if remaining.len() == 1 && remaining.contains(&Mark::MissingOut) {
                continue;
            }
            let e = evaluate_day(
                u,
                &p,
                day,
                entry,
                &[],
                today,
                settings.for_entity(p.legal_entity_id)?,
            );
            for mark in e.marks {
                if remaining.remove(&mark)
                    && let Some(group) = issues.get_mut(&mark)
                {
                    group.earliest_date = day;
                }
            }
        }
        day += Duration::days(1);
    }
    Ok(())
}
