// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_action_inbox_application::{ActionInboxSourceItem, ActionInboxSourcePage, merge_pages};
use time::{Duration, OffsetDateTime};

#[test]
fn every_home_kind_carries_its_lane_and_database_deadline_days() {
    let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    for (kind, lane) in [
        ("org_change_approve", "turn"),
        ("org_change_draft", "turn"),
        ("org_change_apply", "turn"),
        ("org_change_rejected", "turn"),
        ("org_change_settle", "turn"),
        ("org_change_waiting", "waiting"),
        ("org_change_scheduled", "scheduled"),
        ("hr_exit_confirm", "turn"),
        ("hr_exit_confirm_hq", "turn"),
        ("hr_exit_settle", "turn"),
        ("period_unlock", "turn"),
        ("hr_request", "turn"),
        ("contract_renewal", "turn"),
        ("insurance_filing", "turn"),
        ("identity_review", "turn"),
        ("home_branch_review", "turn"),
        ("register_review", "turn"),
        ("lifecycle_apply_failed", "turn"),
        ("setup_entity", "turn"),
        ("grant_notice", "turn"),
        ("account_security", "turn"),
    ] {
        let page = merge_pages(
            vec![ActionInboxSourcePage {
                items: vec![ActionInboxSourceItem {
                    id: format!("{kind}:00000000-0000-0000-0000-000000000001"),
                    kind: kind.into(),
                    ref_code: String::new(),
                    title: "대상".into(),
                    site: None,
                    who: None,
                    due: Some(now + Duration::days(3)),
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
        );
        let wire = serde_json::to_value(page).unwrap();
        assert_eq!(wire["items"][0]["lane"], lane, "{kind}");
        assert_eq!(wire["items"][0]["days_remaining"], 3, "{kind}");
    }
}

#[test]
fn every_statutory_filing_kind_has_a_round_trip_continuation() {
    use console_action_inbox_application::{ActionInboxPosition, encode_cursor, parse_cursor};
    let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    for kind in [
        "ACQUIRE",
        "LOSE",
        "LEAVE",
        "RESUME",
        "AGE60",
        "WORK_CONFIRMATION",
        "SEPARATION_CERTIFICATE",
        "ACQUIRE_REQUESTED",
        "MONTHLY_REMUNERATION",
    ] {
        let position = ActionInboxPosition {
            created_at: now,
            id: format!("insurance_filing_{kind}_NPS:00000000-0000-0000-0000-000000000001"),
        };
        let cursor = parse_cursor(&encode_cursor(now, &position), now)
            .unwrap_or_else(|_| panic!("{kind} cursor must round-trip"));
        assert_eq!(cursor.position, position);
    }
}

#[test]
fn server_views_cross_nonmatching_pages_and_keep_the_admission_boundary() {
    use console_action_inbox_application::{
        ActionInboxSource, ActionInboxSourceFuture, ActionInboxSourcePort, ActionInboxSourceQuery,
        InboxFilter, ListActionInboxQuery, list_filtered_action_inbox,
    };
    struct Source(Vec<ActionInboxSourceItem>);
    impl ActionInboxSourcePort for Source {
        fn list_source_page(
            &self,
            source: ActionInboxSource,
            query: ActionInboxSourceQuery,
        ) -> ActionInboxSourceFuture<'_> {
            Box::pin(async move {
                let admitted: Vec<_> = self
                    .0
                    .iter()
                    .filter(|i| {
                        source == ActionInboxSource::OrgChange && i.created_at <= query.as_of
                    })
                    .cloned()
                    .collect();
                let total = admitted.len();
                let mut items: Vec<_> = admitted
                    .into_iter()
                    .filter(|i| {
                        query
                            .after
                            .as_ref()
                            .is_none_or(|p| (i.created_at, &i.id) > (p.created_at, &p.id))
                    })
                    .collect();
                let has_more = items.len() > query.limit;
                items.truncate(query.limit);
                Ok(ActionInboxSourcePage {
                    items,
                    total,
                    total_is_exact: true,
                    has_more,
                })
            })
        }
    }
    let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    let mut source = Source(
        (0..405)
            .map(|index| ActionInboxSourceItem {
                id: format!("org_change:{}", uuid::Uuid::from_u128(index + 1)),
                kind: if index == 201 || index == 404 {
                    "org_change_waiting"
                } else {
                    "org_change_draft"
                }
                .into(),
                title: "조직 변경".into(),
                ref_code: String::new(),
                site: None,
                who: None,
                due: None,
                submitted: None,
                links: vec![],
                created_at: now - Duration::seconds(500 - index as i64),
            })
            .collect(),
    );
    let first = ready(list_filtered_action_inbox(
        &source,
        ListActionInboxQuery {
            limit: Some(1),
            cursor: None,
        },
        InboxFilter::Waiting,
        now,
    ))
    .unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(
        first.items[0].id,
        format!("org_change:{}", uuid::Uuid::from_u128(202))
    );
    let mut late = source.0[404].clone();
    late.created_at = now + Duration::SECOND;
    late.id = format!("org_change:{}", uuid::Uuid::from_u128(999));
    source.0.push(late);
    let next = ready(list_filtered_action_inbox(
        &source,
        ListActionInboxQuery {
            limit: Some(1),
            cursor: first.next_cursor,
        },
        InboxFilter::Waiting,
        now + Duration::seconds(2),
    ))
    .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_eq!(
        next.items[0].id,
        format!("org_change:{}", uuid::Uuid::from_u128(405))
    );
    assert!(next.next_cursor.is_none());
}

fn ready<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("fake source should be ready"),
    }
}
