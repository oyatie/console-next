// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::*;
use time::{Duration, OffsetDateTime};

fn ready<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("fake source should be ready"),
    }
}

struct Source(i64);
impl ActionInboxSourcePort for Source {
    fn deadline_due_soon_days(&self) -> i64 {
        self.0
    }

    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            let items = if source == ActionInboxSource::OrgChange {
                vec![ActionInboxSourceItem {
                    context: None,
                    id: "org_change:00000000-0000-0000-0000-000000000001".into(),
                    kind: "org_change_draft".into(),
                    ref_code: String::new(),
                    title: "기한".into(),
                    site: None,
                    who: None,
                    due: Some(query.now + Duration::days(3)),
                    submitted: None,
                    links: vec![],
                    created_at: query.now,
                }]
            } else {
                vec![]
            };
            Ok(ActionInboxSourcePage {
                total: items.len(),
                items,
                total_is_exact: true,
                has_more: false,
            })
        })
    }
}

#[test]
fn exact_traversal_keeps_the_sources_display_window() {
    for (window, tone) in [(2, "neutral"), (3, "warn")] {
        let page = ready(list_complete_action_inbox(
            &Source(window),
            OffsetDateTime::UNIX_EPOCH,
        ))
        .unwrap();
        assert_eq!(page.items[0].due_tone, tone);
    }
}

#[test]
fn a_deadline_three_days_away_is_in_the_shared_display_window() {
    let now = OffsetDateTime::UNIX_EPOCH;
    assert_eq!(
        urgency(
            Some(now + Duration::days(3)),
            now,
            console_settings_domain::keys::DEADLINE_DUE_SOON_DAYS,
        ),
        ("today", "warn")
    );
}
