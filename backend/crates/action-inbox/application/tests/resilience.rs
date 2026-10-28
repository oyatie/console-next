// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::*;
use console_kernel_core::KernelError;
fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("fake source must be ready"),
    }
}
use time::{Duration, OffsetDateTime};

struct Source {
    failed: Option<ActionInboxSource>,
}
impl ActionInboxSourcePort for Source {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            if self.failed == Some(source) {
                return Err(KernelError::internal("private database failure"));
            }
            let items = if source == ActionInboxSource::OrgChange {
                [
                    ("org_change_apply", Some(-1)),
                    ("org_change_draft", Some(1)),
                    ("org_change_scheduled", Some(1)),
                    (
                        "org_change_draft",
                        Some(
                            (console_settings_domain::SettingKey::DeadlineDueSoonDays
                                .def()
                                .default
                                .unwrap()
                                .as_int()
                                .unwrap()
                                + 2)
                                * 24,
                        ),
                    ),
                    ("org_change_draft", None),
                ]
                .into_iter()
                .enumerate()
                .map(|(n, (kind, hours))| row(n, kind, hours, query.now))
                .collect()
            } else if source == ActionInboxSource::HrLifecycle {
                vec![
                    row(6, "lifecycle_apply_failed", None, query.now),
                    row(7, "hr_lifecycle", None, query.now),
                ]
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
fn row(n: usize, kind: &str, hours: Option<i64>, now: OffsetDateTime) -> ActionInboxSourceItem {
    ActionInboxSourceItem {
        context: None,
        id: format!("org_change:{}", uuid::Uuid::from_u128(n as u128 + 1)),
        kind: kind.into(),
        ref_code: String::new(),
        title: "work".into(),
        site: None,
        who: None,
        due: hours.map(|h| now + Duration::hours(h)),
        submitted: None,
        links: vec![],
        created_at: now,
    }
}
#[test]
fn deadlines_include_only_urgent_my_turn_and_failures_only_failed_actions() {
    let now = OffsetDateTime::now_utc();
    let source = Source { failed: None };
    let due = block_on(list_filtered_action_inbox(
        &source,
        ListActionInboxQuery::default(),
        InboxFilter::Deadlines,
        now,
    ))
    .unwrap();
    assert_eq!(
        due.items
            .iter()
            .map(|i| i.kind.as_str())
            .collect::<Vec<_>>(),
        ["org_change_apply", "org_change_draft"]
    );
    let failed = block_on(list_filtered_action_inbox(
        &source,
        ListActionInboxQuery::default(),
        InboxFilter::Failures,
        now,
    ))
    .unwrap();
    assert_eq!(
        failed
            .items
            .iter()
            .map(|i| i.kind.as_str())
            .collect::<Vec<_>>(),
        ["lifecycle_apply_failed"]
    );
}
#[test]
fn each_source_failure_keeps_healthy_work_and_marks_an_inexact_named_outage() {
    for failed in ActionInboxSource::ALL {
        let page = block_on(list_action_inbox(
            &Source {
                failed: Some(failed),
            },
            ListActionInboxQuery::default(),
            OffsetDateTime::now_utc(),
        ))
        .unwrap();
        assert!(!page.total_is_exact, "{failed:?}");
        assert!(!page.items.is_empty(), "{failed:?} blanked healthy work");
        let wire = serde_json::to_value(page).unwrap();
        assert_eq!(
            wire["unavailable"].as_array().unwrap().len(),
            1,
            "{failed:?}"
        );
        assert!(!wire.to_string().contains("private database failure"));
    }
}
