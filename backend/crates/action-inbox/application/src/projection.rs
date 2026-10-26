// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{ActionInboxItem, ActionInboxSourceItem};
use time::OffsetDateTime;

pub(super) fn project_item(
    item: ActionInboxSourceItem,
    now: OffsetDateTime,
    due_soon_days: i64,
) -> ActionInboxItem {
    let (urg, due_tone) = urgency(item.due, now, due_soon_days);
    ActionInboxItem {
        context: item.context,
        lane: match item.kind.as_str() {
            "org_change_waiting" | "identifier_correction_waiting" => "waiting",
            "org_change_scheduled" => "scheduled",
            _ => "turn",
        },
        days_remaining: item.due.map(|due| {
            let zone = time::UtcOffset::from_hms(9, 0, 0).unwrap_or(time::UtcOffset::UTC);
            (due.to_offset(zone).date() - now.to_offset(zone).date()).whole_days()
        }),
        id: item.id,
        kind: item.kind,
        urg,
        ref_code: item.ref_code,
        title: item.title,
        site: item.site,
        who: item.who,
        due: item.due,
        due_tone,
        submitted: item.submitted,
        links: item.links,
        done: false,
        created_at: item.created_at,
    }
}

pub fn urgency(
    due: Option<OffsetDateTime>,
    now: OffsetDateTime,
    due_soon_days: i64,
) -> (&'static str, &'static str) {
    let days = due.map(|due| {
        let zone = time::macros::offset!(+9);
        // Timestamp clocks can expire before the end of their local calendar day.
        if due <= now {
            -1
        } else {
            (due.to_offset(zone).date() - now.to_offset(zone).date()).whole_days()
        }
    });
    match console_compliance_domain::statutory::deadline::severity(days, due_soon_days) {
        "over" => ("now", "danger"),
        "due" => ("today", "warn"),
        _ => ("wait", "neutral"),
    }
}
