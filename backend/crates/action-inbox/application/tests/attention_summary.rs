// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::*;
use time::{Duration, OffsetDateTime};

struct Sources;
impl ActionInboxSourcePort for Sources {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
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
fn read(filter: InboxFilter, cursor: Option<String>, limit: usize) -> ActionInboxPage {
    let mut future = std::pin::pin!(list_filtered_action_inbox(
        &Sources,
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
    let page = read(InboxFilter::All, None, 3);
    let count = page
        .attention_filters
        .iter()
        .find(|c| c.key == Attention::Approvals)
        .unwrap();
    assert_eq!(count.total, 1);
    assert!(count.total_is_exact);
    assert!(page.attention_filters[2].total_is_exact);
    assert!(page.attention_filters[3].total_is_exact);
    let bounded = read(InboxFilter::All, None, 1);
    assert!(!bounded.attention_filters[1].total_is_exact);
}
#[test]
fn continuation_summaries_cover_the_whole_inbox_for_every_view() {
    for filter in [InboxFilter::All, InboxFilter::Turn, InboxFilter::Waiting] {
        let first = read(filter, None, 1);
        let next = read(filter, Some(first.next_cursor.unwrap()), 1);
        assert_eq!(
            next.attention_filters, first.attention_filters,
            "{filter:?}"
        );
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
