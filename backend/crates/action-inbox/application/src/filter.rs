// SPDX-License-Identifier: LicenseRef-Proprietary
//! Server-side saved views over the same immutable traversal as the unfiltered queue.
use console_kernel_core::KernelError;
use serde::Deserialize;
use time::OffsetDateTime;

use crate::{
    ActionInboxItem, ActionInboxPage, ActionInboxPosition, ActionInboxSourcePort,
    ListActionInboxQuery, MAX_PAGE_LIMIT, encode_cursor, list_action_inbox, parse_cursor,
};

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxFilter {
    #[default]
    All,
    Turn,
    Waiting,
    Scheduled,
    Deadlines,
    Failures,
}

impl InboxFilter {
    fn includes(self, item: &ActionInboxItem) -> bool {
        match self {
            Self::All => true,
            Self::Turn => item.lane == "turn",
            Self::Waiting => item.lane == "waiting",
            Self::Scheduled => item.lane == "scheduled",
            Self::Deadlines => item.lane == "turn" && matches!(item.due_tone, "danger" | "warn"),
            Self::Failures => item.kind == "lifecycle_apply_failed",
        }
    }
}

/// A view may scan past non-matching rows, but its continuation always names
/// the last returned row. Resolved rows disappear and new inserts stay beyond
/// the admission instant. Inexact counts explicitly describe a prefix only.
pub async fn list_filtered_action_inbox(
    port: &dyn ActionInboxSourcePort,
    query: ListActionInboxQuery,
    filter: InboxFilter,
    now: OffsetDateTime,
) -> Result<ActionInboxPage, KernelError> {
    if filter == InboxFilter::All {
        return list_action_inbox(port, query, now).await;
    }
    let limit = query
        .limit
        .unwrap_or(crate::DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let first = query.cursor.is_none();
    let mut cursor = query.cursor;
    let as_of = cursor
        .as_deref()
        .map(|c| parse_cursor(c, now))
        .transpose()?
        .map_or(now, |c| c.as_of);
    let view = ViewPort { port, filter };
    let mut exact = true;
    let mut unavailable = Vec::new();
    let mut summary = None;
    let mut items = Vec::new();
    loop {
        let page = list_action_inbox(
            if first && summary.is_none() {
                port
            } else {
                &view
            },
            ListActionInboxQuery {
                limit: Some(MAX_PAGE_LIMIT),
                cursor: cursor.clone(),
            },
            now,
        )
        .await?;
        exact &= page.total_is_exact;
        for source in page.unavailable {
            if !unavailable.contains(&source) {
                unavailable.push(source);
            }
        }
        if summary.is_none() {
            summary = Some((page.counts, page.upcoming));
        }
        items.extend(page.items.into_iter().filter(|item| filter.includes(item)));
        if items.len() > limit {
            items.truncate(limit);
            let last = items
                .last()
                .ok_or_else(|| KernelError::internal("empty inbox continuation"))?;
            let next_cursor = Some(encode_cursor(
                as_of,
                &ActionInboxPosition {
                    created_at: last.created_at,
                    id: last.id.clone(),
                },
            ));
            let (counts, upcoming) = summary.unwrap_or_default();
            return Ok(ActionInboxPage {
                unavailable,
                counts,
                upcoming,
                total: items.len(),
                total_is_exact: false,
                items,
                next_cursor,
            });
        }
        match page.next_cursor {
            Some(next) if cursor.as_ref() != Some(&next) => cursor = Some(next),
            Some(_) => return Err(KernelError::internal("inbox source repeated its cursor")),
            None => {
                let (counts, upcoming) = summary.unwrap_or_default();
                return Ok(ActionInboxPage {
                    unavailable,
                    counts,
                    upcoming,
                    total: items.len(),
                    total_is_exact: first && exact,
                    items,
                    next_cursor: None,
                });
            }
        }
    }
}

struct ViewPort<'a> {
    port: &'a dyn ActionInboxSourcePort,
    filter: InboxFilter,
}
impl ActionInboxSourcePort for ViewPort<'_> {
    fn list_source_page(
        &self,
        source: crate::ActionInboxSource,
        mut query: crate::ActionInboxSourceQuery,
    ) -> crate::ActionInboxSourceFuture<'_> {
        use crate::ActionInboxSource as S;
        let included = match self.filter {
            InboxFilter::Waiting => matches!(source, S::OrgChange | S::EntityCorrections),
            InboxFilter::Scheduled => source == S::OrgChange,
            InboxFilter::Failures => source == S::HrLifecycle,
            InboxFilter::Deadlines => !matches!(
                source,
                S::HrIdentity
                    | S::HrBranch
                    | S::HrRegister
                    | S::HrRequests
                    | S::HrLifecycle
                    | S::Setup
                    | S::GrantNotice
                    | S::Payroll
                    | S::Governance
                    | S::RegistrationChecks
            ),
            _ => true,
        };
        if included {
            query.filter = self.filter;
            self.port.list_source_page(source, query)
        } else {
            Box::pin(async {
                Ok(crate::ActionInboxSourcePage {
                    items: Vec::new(),
                    total: 0,
                    total_is_exact: true,
                    has_more: false,
                })
            })
        }
    }
}

pub(crate) fn counts(
    items: &[ActionInboxItem],
    exact: bool,
) -> std::collections::BTreeMap<&'static str, crate::InboxCount> {
    [
        ("turn", InboxFilter::Turn),
        ("waiting", InboxFilter::Waiting),
        ("scheduled", InboxFilter::Scheduled),
        ("deadlines", InboxFilter::Deadlines),
        ("failures", InboxFilter::Failures),
    ]
    .into_iter()
    .map(|(key, filter)| {
        (
            key,
            crate::InboxCount {
                total: items.iter().filter(|item| filter.includes(item)).count(),
                total_is_exact: exact,
            },
        )
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ActionInboxSource as S, ActionInboxSourceFuture, ActionInboxSourcePage,
        ActionInboxSourceQuery,
    };
    use std::{
        sync::Mutex,
        task::{Context, Poll, Waker},
    };

    #[derive(Default)]
    struct RecordingPort(Mutex<Vec<(S, ActionInboxSourceQuery)>>);

    impl ActionInboxSourcePort for RecordingPort {
        fn list_source_page(
            &self,
            source: S,
            query: ActionInboxSourceQuery,
        ) -> ActionInboxSourceFuture<'_> {
            self.0.lock().unwrap().push((source, query));
            Box::pin(async {
                Ok(ActionInboxSourcePage {
                    items: Vec::new(),
                    total: 7,
                    total_is_exact: false,
                    has_more: true,
                })
            })
        }
    }

    #[test]
    fn saved_views_call_only_their_sources_and_forward_the_filter() {
        let deadlines = [
            S::Workflow,
            S::Dispatch,
            S::Support,
            S::WorkOrder,
            S::OrgChange,
            S::HrExit,
            S::HrInsurance,
            S::HrContract,
            S::PeriodUnlock,
            S::SupportAccess,
            S::EntityCorrections,
        ];
        for (filter, expected) in [
            (
                InboxFilter::Waiting,
                &[S::OrgChange, S::EntityCorrections][..],
            ),
            (InboxFilter::Scheduled, &[S::OrgChange][..]),
            (InboxFilter::Failures, &[S::HrLifecycle][..]),
            (InboxFilter::Deadlines, &deadlines[..]),
        ] {
            let port = RecordingPort::default();
            let view = ViewPort {
                port: &port,
                filter,
            };
            let query = ActionInboxSourceQuery {
                filter: InboxFilter::All,
                require_exact_total: true,
                now: OffsetDateTime::UNIX_EPOCH + time::Duration::days(2),
                as_of: OffsetDateTime::UNIX_EPOCH + time::Duration::days(1),
                after: Some(ActionInboxPosition {
                    created_at: OffsetDateTime::UNIX_EPOCH,
                    id: "workflow:previous".into(),
                }),
                limit: 17,
            };
            for source in S::ALL {
                let mut future = view.list_source_page(source, query.clone());
                let Poll::Ready(result) = future
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                else {
                    panic!("the recording source must be ready");
                };
                let page = result.unwrap();
                assert!(page.items.is_empty());
                if expected.contains(&source) {
                    assert_eq!(page.total, 7, "{filter:?}: {source:?}");
                    assert!(!page.total_is_exact);
                    assert!(page.has_more);
                } else {
                    assert_eq!(page.total, 0, "{filter:?}: {source:?}");
                    assert!(page.total_is_exact);
                    assert!(!page.has_more);
                }
            }
            let mut forwarded = query;
            forwarded.filter = filter;
            assert_eq!(
                *port.0.lock().unwrap(),
                S::ALL
                    .into_iter()
                    .filter(|source| expected.contains(source))
                    .map(|source| (source, forwarded.clone()))
                    .collect::<Vec<_>>()
            );
        }
    }

    fn item(lane: &'static str, due_tone: &'static str, kind: &str) -> ActionInboxItem {
        ActionInboxItem {
            context: None,
            id: String::new(),
            kind: kind.into(),
            urg: "normal",
            ref_code: String::new(),
            title: String::new(),
            site: None,
            who: None,
            due: None,
            due_tone,
            submitted: None,
            links: Vec::new(),
            done: false,
            lane,
            days_remaining: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn counts_preserve_each_view_predicate_and_exactness() {
        let items = [
            item("turn", "danger", "workflow"),
            item("turn", "warn", "lifecycle_apply_failed"),
            item("turn", "neutral", "workflow"),
            item("waiting", "danger", "lifecycle_apply_failed"),
            item("waiting", "warn", "workflow"),
            item("scheduled", "danger", "workflow"),
            item("scheduled", "neutral", "workflow"),
        ];
        for exact in [true, false] {
            let result = counts(&items, exact);
            assert_eq!(result.len(), 5);
            for (key, total) in [
                ("turn", 3),
                ("waiting", 2),
                ("scheduled", 2),
                ("deadlines", 2),
                ("failures", 2),
            ] {
                assert_eq!(
                    result[key],
                    crate::InboxCount {
                        total,
                        total_is_exact: exact
                    },
                    "{key}"
                );
            }
        }
    }
}
