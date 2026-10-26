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
    fn deadline_due_soon_days(&self) -> Result<i64, console_kernel_core::KernelError> {
        Ok(self.0)
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
            console_settings_domain::SettingKey::DeadlineDueSoonDays
                .def()
                .default
                .unwrap()
                .as_int()
                .unwrap(),
        ),
        ("today", "warn")
    );
}

#[test]
fn scheduled_system_acts_stay_neutral_even_when_their_date_has_passed() {
    let now = OffsetDateTime::UNIX_EPOCH;
    for days in [-1, 0, 3, 7] {
        let page = merge_pages(
            vec![ActionInboxSourcePage {
                items: vec![ActionInboxSourceItem {
                    context: None,
                    id: "scheduled:1".into(),
                    kind: "org_change_scheduled".into(),
                    ref_code: String::new(),
                    title: "예약".into(),
                    site: None,
                    who: None,
                    due: Some(now + Duration::days(days)),
                    submitted: None,
                    links: vec![],
                    created_at: now,
                }],
                total: 1,
                total_is_exact: true,
                has_more: false,
            }],
            now,
            now,
            None,
            10,
            7,
        );
        assert_eq!(
            (page.items[0].urg, page.items[0].due_tone),
            ("wait", "neutral")
        );
        assert_eq!(page.items[0].days_remaining, Some(days));
    }
}
