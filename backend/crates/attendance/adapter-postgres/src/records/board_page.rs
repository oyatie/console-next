// SPDX-License-Identifier: LicenseRef-Proprietary
//! Filter and page rows only after the full authorized scope has been counted.
use console_attendance_application::records_read::BoardGroup;
use uuid::Uuid;

use super::BoardQuery;

pub(super) fn page(groups: &mut Vec<BoardGroup>, q: &BoardQuery) -> Option<Uuid> {
    if let Some(mark) = q.mark {
        for group in groups.iter_mut() {
            group.rows.retain(|row| row.day.marks.contains(&mark));
            group.hidden = 0;
        }
        groups.retain(|group| !group.rows.is_empty());
    }
    let mut ids: Vec<_> = groups
        .iter()
        .flat_map(|g| &g.rows)
        .map(|row| row.employee_id)
        .filter(|id| q.cursor.is_none_or(|cursor| *id > cursor))
        .collect();
    ids.sort_unstable();
    let limit = q
        .limit
        .map(|limit| limit.clamp(1, 200))
        .unwrap_or(ids.len());
    let next_cursor = (ids.len() > limit).then(|| ids[limit - 1]);
    ids.truncate(limit);
    if q.cursor.is_some() || q.limit.is_some() {
        for group in groups.iter_mut() {
            group
                .rows
                .retain(|row| ids.binary_search(&row.employee_id).is_ok());
        }
        groups.retain(|group| !group.rows.is_empty());
    }
    next_cursor
}
