// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::*;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

fn row(
    kind: &str,
    created_at: OffsetDateTime,
    due: Option<OffsetDateTime>,
) -> ActionInboxSourceItem {
    ActionInboxSourceItem {
        due_basis: None,
        context: Some(json!({"reason":"기록된 요청 사유"})),
        id: format!("org_change:{}", uuid::Uuid::new_v4()),
        kind: kind.into(),
        ref_code: String::new(),
        title: "대상".into(),
        site: None,
        who: None,
        due,
        submitted: None,
        links: vec![],
        created_at,
    }
}

#[test]
fn attention_metadata_uses_each_items_facts_and_counts_before_page_truncation() {
    let now = OffsetDateTime::parse(
        "2026-11-04T03:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let items = vec![
        row("org_change_approve", now - Duration::days(12), None),
        row(
            "insurance_filing",
            now - Duration::days(4),
            Some(now - Duration::DAY),
        ),
        row(
            "contract_renewal",
            now - Duration::days(2),
            Some(now + Duration::HOUR),
        ),
        row(
            "org_change_waiting",
            now - Duration::DAY,
            Some(now - Duration::DAY),
        ),
        row("org_change_scheduled", now, Some(now + Duration::HOUR)),
    ];
    let page = merge_pages(
        vec![ActionInboxSourcePage {
            total: items.len(),
            items,
            total_is_exact: true,
            has_more: false,
        }],
        now,
        now,
        None,
        1,
        3,
    );
    let value = serde_json::to_value(&page).unwrap();
    assert_eq!(
        value["attention_filters"],
        json!([
            {"key":"all","total":5,"total_is_exact":true},
            {"key":"approvals","total":1,"total_is_exact":true},
            {"key":"today","total":1,"total_is_exact":true},
            {"key":"overdue","total":1,"total_is_exact":true}
        ])
    );
    let value = serde_json::to_value(merge_pages(
        vec![ActionInboxSourcePage {
            items: vec![row("org_change_approve", now - Duration::days(12), None)],
            total: 20,
            total_is_exact: true,
            has_more: true,
        }],
        now,
        now,
        None,
        1,
        3,
    ))
    .unwrap();
    assert_eq!(value["items"][0]["age_days"], 12);
    assert!(value["items"][0].get("reason").is_none());
    assert_eq!(value["items"][0]["context"]["reason"], "기록된 요청 사유");
    assert_eq!(value["attention_filters"][0]["total"], 20);
    assert_eq!(value["attention_filters"][1]["total_is_exact"], false);
}

#[test]
fn aging_is_calendar_days_and_clamped_at_zero_without_display_copy() {
    let now = OffsetDateTime::parse(
        "2026-11-04T15:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    for (created, age, context) in [
        (now - Duration::MINUTE, 1, None),
        (now, 0, Some(json!({"reason":"  "}))),
        (now + Duration::DAY, 0, None),
    ] {
        let mut item = row("org_change_approve", created, None);
        item.context = context;
        let page = merge_pages(
            vec![ActionInboxSourcePage {
                items: vec![item],
                total: 1,
                total_is_exact: true,
                has_more: false,
            }],
            now,
            now.max(created),
            None,
            1,
            3,
        );
        let value: Value = serde_json::to_value(page).unwrap();
        assert_eq!(value["items"][0]["age_days"], age);
        assert!(value["items"][0].get("reason").is_none());
    }
}

#[test]
fn a_failure_after_scanning_a_nonmatching_page_invalidates_attention_counts() {
    struct Source;
    impl ActionInboxSourcePort for Source {
        fn list_source_page(
            &self,
            source: ActionInboxSource,
            query: ActionInboxSourceQuery,
        ) -> ActionInboxSourceFuture<'_> {
            Box::pin(async move {
                if source == ActionInboxSource::HrIdentity && query.after.is_some() {
                    return Err(console_kernel_core::KernelError::internal("source failed"));
                }
                let items = match source {
                    ActionInboxSource::OrgChange => vec![row(
                        "org_change_approve",
                        query.now - Duration::days(3),
                        None,
                    )],
                    ActionInboxSource::PeriodUnlock => vec![row(
                        "org_change_waiting",
                        query.now - Duration::days(2),
                        None,
                    )],
                    ActionInboxSource::HrIdentity => {
                        vec![row("identity_review", query.now - Duration::DAY, None)]
                    }
                    _ => vec![],
                };
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
    let now = OffsetDateTime::UNIX_EPOCH + Duration::days(4);
    let future = list_filtered_action_inbox(
        &Source,
        ListActionInboxQuery {
            limit: Some(1),
            cursor: None,
        },
        InboxFilter::Turn,
        now,
    );
    let mut future = std::pin::pin!(future);
    let std::task::Poll::Ready(page) = future
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
    else {
        panic!("fake source should be ready")
    };
    let value = serde_json::to_value(page.unwrap()).unwrap();
    assert_eq!(value["items"].as_array().unwrap().len(), 1);
    assert_eq!(value["unavailable"], json!(["hr_identity"]));
    for count in value["attention_filters"].as_array().unwrap() {
        assert_eq!(count["total_is_exact"], false);
    }
}
