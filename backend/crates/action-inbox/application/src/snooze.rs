// SPDX-License-Identifier: LicenseRef-Proprietary
//! Postponing is the account's own view of an item. A snoozed item leaves the
//! list, its pages and its totals together, and returns on its date or when
//! the item changes. Nothing here writes: a snooze ends at read.
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::{Date, Duration, OffsetDateTime};

use crate::{
    ActionInboxItem, ActionInboxPage, ActionInboxPosition, ActionInboxSource,
    ActionInboxSourceFuture, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourcePort,
    ActionInboxSourceQuery, Attention, InboxCount, MAX_PAGE_LIMIT,
};

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

// shortcut: at most this many further raw pages per source and request; past it a total turns
// inexact and the snoozed view stops listing. Upgrade when a source can be asked for ids.
const MAX_SCAN_PAGES: usize = crate::MAX_COMPLETE_PAGES;

/// The calendar day in Korea, where every inbox deadline is counted.
#[must_use]
pub fn kst_date(at: OffsetDateTime) -> Date {
    at.to_offset(time::macros::offset!(+9)).date()
}

/// Where an item's due date comes from, when that limits what may be done with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DueBasis {
    /// The due date is a legal deadline read from the statutory register.
    Statutory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnoozeBlock {
    /// A decision someone else is waiting on.
    BlocksOthers,
}

/// Why a snooze is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnoozeRefusal {
    Past,
    NotAllowed,
    /// On or after a legal deadline; carries the last date that is allowed.
    PastLegalDue(Date),
}

/// What an item says about postponing it. The list serves these and the command enforces them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnoozeFacts {
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SnoozeBlock>,
    /// The date the item returns; served in the snoozed view only.
    #[serde(
        default,
        with = "iso_date::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub until: Option<Date>,
    /// The day before a legal deadline; absent when the date is unbounded.
    #[serde(
        default,
        with = "iso_date::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub latest: Option<Date>,
}

impl SnoozeFacts {
    pub(crate) fn of(item: &ActionInboxItem) -> Self {
        let blocks = Attention::Approvals.includes(item);
        Self {
            allowed: !blocks,
            reason: blocks.then_some(SnoozeBlock::BlocksOthers),
            until: None,
            latest: item
                .due
                .filter(|_| item.due_basis == Some(DueBasis::Statutory))
                .and_then(|due| kst_date(due).previous_day()),
        }
    }

    /// # Errors
    /// The first rule `until` breaks, given today's date in Korea.
    pub fn check(&self, until: Date, today: Date) -> Result<(), SnoozeRefusal> {
        if until <= today {
            return Err(SnoozeRefusal::Past);
        }
        if !self.allowed {
            return Err(SnoozeRefusal::NotAllowed);
        }
        match self.latest {
            Some(latest) if until > latest => Err(SnoozeRefusal::PastLegalDue(latest)),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnoozePreset {
    pub key: &'static str,
    #[serde(with = "iso_date")]
    pub date: Date,
}

/// The presets with their dates resolved, so no client does date arithmetic.
#[must_use]
pub fn presets(today: Date, short_days: i64, long_days: i64) -> Vec<SnoozePreset> {
    let monday = 7 - i64::from(today.weekday().number_days_from_monday());
    [
        ("short", short_days),
        ("next_week", monday),
        ("long", long_days),
    ]
    .into_iter()
    .filter_map(|(key, days)| {
        let date = today.checked_add(Duration::days(days))?;
        Some(SnoozePreset { key, date })
    })
    .collect()
}

/// One stored snooze of the account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snooze {
    pub until: Date,
    /// The item's decision version when it was snoozed.
    pub item_version: Option<String>,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SnoozeMode {
    /// The list: snoozed items are left out.
    #[default]
    Exclude,
    /// The snoozed view: nothing else is listed.
    Only,
    /// Finding one item whether or not it is snoozed.
    Include,
}

/// The account's snoozes for one request, read once before any source runs.
#[derive(Debug, Default)]
pub struct Snoozes {
    set: HashMap<String, Snooze>,
    mode: SnoozeMode,
    /// What this request has learned of each snoozed id: hidden, or not (woken, or gone).
    seen: Mutex<HashMap<String, bool>>,
}

impl Snoozes {
    /// Rows whose date has come are dropped here: the item is back.
    #[must_use]
    pub fn new(
        rows: impl IntoIterator<Item = (String, Snooze)>,
        mode: SnoozeMode,
        now: OffsetDateTime,
    ) -> Self {
        let today = kst_date(now);
        Self {
            set: rows
                .into_iter()
                .filter(|(_, snooze)| snooze.until > today)
                .collect(),
            mode,
            seen: Mutex::default(),
        }
    }

    fn seen(&self) -> MutexGuard<'_, HashMap<String, bool>> {
        self.seen.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `None` when the item is not snoozed, else whether the snooze still hides it.
    fn hides(&self, item: &ActionInboxSourceItem, now: OffsetDateTime) -> Option<bool> {
        let snooze = self.set.get(&item.id)?;
        let version = item
            .context
            .as_ref()
            .and_then(|context| context["decision"]["version"].as_str());
        // A postponed item must not hide a new fact: someone acted on it, or its deadline passed since.
        let woke = version != snooze.item_version.as_deref()
            || item
                .due
                .is_some_and(|due| snooze.created_at < due && due <= now);
        Some(!woke)
    }

    /// Adds the snoozed count, and each row's return date in the snoozed view.
    pub fn annotate(&self, page: &mut ActionInboxPage) {
        let seen = self.seen();
        page.counts.insert(
            "snoozed",
            InboxCount {
                total: seen.values().filter(|hidden| **hidden).count(),
                total_is_exact: self.set.keys().all(|id| seen.contains_key(id)),
            },
        );
        if self.mode == SnoozeMode::Only {
            for item in page.items.iter_mut().chain(&mut page.upcoming) {
                item.snooze.until = self.set.get(&item.id).map(|snooze| snooze.until);
            }
        }
    }
}

/// Every consumer reads its sources through this, so a snoozed item leaves the
/// page and the total together, never one without the other.
pub struct SnoozedPort<'a> {
    pub port: &'a dyn ActionInboxSourcePort,
    pub snoozes: &'a Snoozes,
}

impl ActionInboxSourcePort for SnoozedPort<'_> {
    fn deadline_due_soon_days(&self) -> Result<i64, KernelError> {
        self.port.deadline_due_soon_days()
    }

    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        let snoozes = self.snoozes;
        let only = snoozes.mode == SnoozeMode::Only;
        let mine: Vec<&String> = snoozes
            .set
            .keys()
            .filter(|id| crate::namespaced_id::source_of(id) == Some(source))
            .collect();
        if mine.is_empty() && only {
            return Box::pin(async {
                Ok(ActionInboxSourcePage {
                    items: Vec::new(),
                    total: 0,
                    total_is_exact: true,
                    has_more: false,
                })
            });
        }
        if mine.is_empty() || snoozes.mode == SnoozeMode::Include {
            return self.port.list_source_page(source, query);
        }
        Box::pin(async move {
            let (limit, first, exact_wanted) = (
                query.limit,
                query.after.is_none(),
                query.require_exact_total,
            );
            let unseen = || {
                let seen = snoozes.seen();
                mine.iter().filter(|id| !seen.contains_key(**id)).count()
            };
            let (mut kept, mut overflow, mut rounds) = (Vec::new(), false, 0);
            let mut next = query;
            let (raw_total, raw_exact, more) = loop {
                let page = self.port.list_source_page(source, next.clone()).await?;
                let last = page.items.last().map(|item| ActionInboxPosition {
                    created_at: item.created_at,
                    due: item.due,
                    id: item.id.clone(),
                });
                for item in page.items {
                    let hidden = snoozes.hides(&item, next.now);
                    if let Some(hidden) = hidden {
                        snoozes.seen().insert(item.id.clone(), hidden);
                    }
                    if (hidden == Some(true)) != only {
                        continue;
                    }
                    if kept.len() < limit {
                        kept.push(item);
                    } else {
                        overflow = true;
                    }
                }
                // Read on while the page is short, or while an exact total still misses an id.
                let missing = unseen() > 0;
                let wanted =
                    (kept.len() < limit && (!only || missing)) || (missing && exact_wanted);
                match last {
                    Some(last) if page.has_more && wanted && rounds < MAX_SCAN_PAGES => {
                        rounds += 1;
                        next.after = Some(last);
                        next.limit = MAX_PAGE_LIMIT;
                    }
                    _ => break (page.total, page.total_is_exact, page.has_more),
                }
            };
            if !only && more && kept.is_empty() && rounds == MAX_SCAN_PAGES {
                // No row to continue from: say so, do not end the list early.
                return Err(KernelError::unavailable(
                    "postponed items exceed the inbox scan bound",
                ));
            }
            let mut seen = snoozes.seen();
            if first && !more {
                // Read from its start to its end: an id not seen is no longer in this source.
                for id in &mine {
                    seen.entry((*id).clone()).or_insert(false);
                }
            }
            let hidden = mine
                .iter()
                .filter(|id| seen.get(**id) == Some(&true))
                .count();
            let unseen = mine.iter().filter(|id| !seen.contains_key(**id)).count();
            Ok(ActionInboxSourcePage {
                // An id not seen may be hidden further on, so the lower bound leaves it out too.
                total: if only {
                    hidden
                } else {
                    raw_total.saturating_sub(hidden + unseen)
                },
                total_is_exact: unseen == 0 && (only || raw_exact),
                // The snoozed view goes on only from a full page that left a snoozed id unread.
                has_more: overflow || (more && (!only || (unseen > 0 && kept.len() >= limit))),
                items: kept,
            })
        })
    }
}
