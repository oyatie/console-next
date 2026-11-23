// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::ladders::{Credential, EvidenceState, WorkKind};
use console_ops_domain::obligation::{Kind, Obligation, launch_readiness};
use console_ops_domain::{Observed, UtcTimestamp, Verdict};
use time::OffsetDateTime;

use crate::obligations::{Error as SpoolError, Item, Record};
use crate::snapshot::{LinkView, SourceKind, SourceView, WorkItemView};

pub fn build_obligation_home_parts(
    source: Result<(&[Item], &[Record]), SpoolError>,
    now: OffsetDateTime,
    due_soon_days: u32,
    interval_s: NonZeroU64,
) -> (Verdict, Vec<WorkItemView>, SourceView) {
    match source {
        Ok((items, records)) => {
            let obligations: Vec<Obligation> = items.iter().map(|i| i.obligation.clone()).collect();
            let readiness = launch_readiness(Ok(&obligations));

            let mut keyed: Vec<_> = items
                .iter()
                .filter_map(|item| {
                    item.obligation
                        .worklist_key(now, due_soon_days)
                        .map(|key| (key, item))
                })
                .collect();
            keyed.sort_by_key(|(key, _)| *key);

            let workitems = keyed
                .into_iter()
                .map(|(_, item)| {
                    let ob = &item.obligation;
                    let kind_slug = serde_json::to_value(ob.kind())
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_else(|| "obligation".to_owned());
                    let days = ob.days_remaining(now);
                    let state_val = match days {
                        Some(d) if d < 0 => Some(Credential::Overdue),
                        Some(d) if d <= i64::from(due_soon_days) => Some(Credential::Due),
                        Some(_) if ob.kind() == Kind::LaunchGate => Some(Credential::Planned),
                        Some(_) => Some(Credential::Planned),
                        None => None,
                    };
                    let state = match state_val {
                        Some(cred) => Observed::current(
                            serde_json::to_value(cred).unwrap_or_default(),
                            None,
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        ),
                        None => {
                            Observed::unknown("obligations".to_owned(), "no due date".to_owned())
                        }
                    };
                    let last_at = records
                        .iter()
                        .rfind(|r| r.entry.obligation_id == item.id)
                        .map(|r| r.entry.at)
                        .unwrap_or(now);
                    let age_s = u64::try_from((now - last_at).whole_seconds()).unwrap_or_default();
                    let lead_text = if ob.due().is_none() {
                        "No due date".to_owned()
                    } else {
                        ob.deadline(now)
                    };
                    WorkItemView {
                        kind: WorkKind::Obligation,
                        title: Observed::current(
                            ob.title().to_owned(),
                            None,
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        ),
                        component: Observed::current(
                            kind_slug,
                            None,
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        ),
                        state,
                        since: Observed::current(
                            UtcTimestamp::new(last_at),
                            None,
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        ),
                        age: Observed::current(
                            age_s,
                            Some("s".to_owned()),
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        ),
                        lead: Some(Observed::current(
                            lead_text,
                            None,
                            "obligations".to_owned(),
                            now,
                            now,
                            interval_s,
                        )),
                        next: LinkView {
                            href: format!("/obligations/{}", item.id),
                            label: "Review obligation".to_owned(),
                        },
                    }
                })
                .collect();

            let last_record_at = records.last().map(|r| r.entry.at).unwrap_or(now);
            let source_view = SourceView {
                name: "obligations".to_owned(),
                kind: SourceKind::Obligations,
                producer: "ops-records".to_owned(),
                interval: interval_s.get(),
                observed_at: Some(last_record_at),
                age: u64::try_from((now - last_record_at).whole_seconds()).unwrap_or_default(),
                state: EvidenceState::Verified,
                reason: None,
            };
            (readiness, workitems, source_view)
        }
        Err(err) => {
            let reason = err.reason();
            let readiness = launch_readiness(Err(&reason));
            let source_view = SourceView {
                name: "obligations".to_owned(),
                kind: SourceKind::Obligations,
                producer: "ops-records".to_owned(),
                interval: interval_s.get(),
                observed_at: None,
                age: 0,
                state: EvidenceState::Unknown,
                reason: Some(reason),
            };
            (readiness, Vec::new(), source_view)
        }
    }
}
