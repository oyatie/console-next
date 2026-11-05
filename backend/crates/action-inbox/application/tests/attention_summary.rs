// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use time::{Duration, OffsetDateTime};

#[derive(Default)]
struct Sources(AtomicUsize);
impl ActionInboxSourcePort for Sources {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let kinds: &[&str] = match source {
                ActionInboxSource::Workflow => &["approval"],
                ActionInboxSource::HrUnplaced => &["unplaced", "unplaced", "unplaced", "unplaced"],
                ActionInboxSource::OrgChange => &[
                    "org_change_waiting",
                    "org_change_waiting",
                    "org_change_scheduled",
                ],
                _ => &[],
            };
            let items: Vec<_> = kinds
                .iter()
                .enumerate()
                .map(|(n, kind)| ActionInboxSourceItem {
                    context: None,
                    id: format!(
                        "{}:{}",
                        match source {
                            ActionInboxSource::Workflow => "approval",
                            ActionInboxSource::HrUnplaced => "hr_unplaced",
                            _ => "org_change",
                        },
                        uuid::Uuid::from_u128(n as u128 + 1)
                    ),
                    kind: (*kind).into(),
                    ref_code: String::new(),
                    title: String::new(),
                    site: None,
                    who: None,
                    due: None,
                    submitted: None,
                    links: vec![],
                    created_at: query.now - Duration::days(n as i64 + 1),
                })
                .collect();
            let total = items.len();
            let (items, has_more) = page_source_items(items, &query);
            Ok(ActionInboxSourcePage {
                items,
                total,
                total_is_exact: true,
                has_more,
            })
        })
    }
}
fn read(
    sources: &Sources,
    filter: InboxFilter,
    cursor: Option<String>,
    limit: usize,
) -> ActionInboxPage {
    let mut future = std::pin::pin!(list_filtered_action_inbox(
        sources,
        ListActionInboxQuery {
            limit: Some(limit),
            cursor
        },
        filter,
        OffsetDateTime::UNIX_EPOCH + Duration::days(10)
    ));
    let std::task::Poll::Ready(result) = future
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
    else {
        panic!("ready source")
    };
    result.unwrap()
}
#[test]
fn unrelated_incomplete_sources_do_not_make_approval_counts_inexact() {
    let page = read(&Sources::default(), InboxFilter::All, None, 3);
    let count = page
        .attention_filters
        .iter()
        .find(|c| c.key == Attention::Approvals)
        .unwrap();
    assert_eq!(count.total, 1);
    assert!(count.total_is_exact);
    assert!(page.attention_filters[2].total_is_exact);
    assert!(page.attention_filters[3].total_is_exact);
    let bounded = read(&Sources::default(), InboxFilter::All, None, 1);
    assert!(!bounded.attention_filters[1].total_is_exact);
}
#[test]
fn continuation_pages_read_each_source_once() {
    for filter in [InboxFilter::All, InboxFilter::Turn] {
        let sources = Sources::default();
        let first = read(&sources, filter, None, 1);
        sources.0.store(0, Ordering::SeqCst);
        let next = read(&sources, filter, Some(first.next_cursor.unwrap()), 1);
        assert_eq!(
            sources.0.load(Ordering::SeqCst),
            ActionInboxSource::ALL.len(),
            "{filter:?}"
        );
        assert_eq!(next.items.len(), 1);
        assert_ne!(next.items[0].id, first.items[0].id);
    }
}

#[test]
fn every_approval_kind_and_only_approval_kinds_contribute() {
    for kind in [
        "approval",
        "org_change_approve",
        "payroll",
        "governance",
        "period_unlock",
        "support_access",
        "identifier_correction_decide",
        "unplaced",
        "contract_renewal",
        "org_change_waiting",
    ] {
        let now = OffsetDateTime::UNIX_EPOCH;
        let item = ActionInboxSourceItem {
            context: None,
            id: kind.into(),
            kind: kind.into(),
            ref_code: String::new(),
            title: String::new(),
            site: None,
            who: None,
            due: None,
            submitted: None,
            links: vec![],
            created_at: now,
        };
        let page = merge_pages(
            vec![ActionInboxSourcePage {
                items: vec![item],
                total: 1,
                total_is_exact: true,
                has_more: false,
            }],
            now,
            now,
            None,
            1,
            3,
        );
        assert_eq!(
            page.attention_filters[1].total,
            usize::from(!["unplaced", "contract_renewal", "org_change_waiting"].contains(&kind)),
            "{kind}"
        );
    }
}
