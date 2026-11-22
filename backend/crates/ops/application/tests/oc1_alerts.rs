// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Mutex;

use console_ops_application::alert_actions::{
    AlertAckRecord, AlertAckStore, AlertActionsService, AlertmanagerSilencePost,
    AlertmanagerWriter, SilenceAuditRecord, SilenceAuditStore, overlay_acks_and_changes,
};
use console_ops_application::alerts_eval::compute_group_key;
use console_ops_application::domain::Observed;
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::alert_actions::{SilenceCreateInput, SilenceMatcherInput};
use console_ops_application::domain::ladders::{AlertState, Severity};
use console_ops_application::obligations::{Context, Error as SpoolError, Operator};
use console_ops_application::snapshot::{
    AlertGroupDetailView, AlertGroupView, AlertGroupsView, ChangeView, RuleView,
    ValueVsThresholdView,
};
use console_ops_application::{SourceError, SourceFuture};
use time::{Duration, macros::datetime};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct MemAckStore(Mutex<Vec<AlertAckRecord>>);
impl AlertAckStore for MemAckStore {
    fn list_acks(&self) -> Result<Vec<AlertAckRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_ack(
        &self,
        group_key: &str,
        alertname: &str,
        component: &str,
        note: Option<String>,
        context: &Context,
    ) -> Result<AlertAckRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rec = AlertAckRecord {
            seq: g.len() as u64 + 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            group_key: group_key.to_owned(),
            alertname: alertname.to_owned(),
            component: component.to_owned(),
            note,
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

struct MemSilenceStore(Mutex<Vec<SilenceAuditRecord>>);
impl SilenceAuditStore for MemSilenceStore {
    fn list_records(&self) -> Result<Vec<SilenceAuditRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_event(
        &self,
        action: &str,
        silence_id: Option<&str>,
        group_key: Option<&str>,
        detail: Option<&str>,
        context: &Context,
    ) -> Result<SilenceAuditRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rec = SilenceAuditRecord {
            seq: g.len() as u64 + 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            action: action.to_owned(),
            silence_id: silence_id.map(str::to_owned),
            group_key: group_key.map(str::to_owned),
            detail: detail.map(str::to_owned),
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

struct MockWriter {
    fail: bool,
}
impl AlertmanagerWriter for MockWriter {
    fn create_silence(&self, _req: &AlertmanagerSilencePost) -> SourceFuture<'_, String> {
        let fail = self.fail;
        Box::pin(async move {
            if fail {
                Err(SourceError::Down)
            } else {
                Ok("sil-9".into())
            }
        })
    }
    fn delete_silence(&self, _id: &str) -> SourceFuture<'_, ()> {
        let fail = self.fail;
        Box::pin(async move { if fail { Err(SourceError::Down) } else { Ok(()) } })
    }
}

#[test]
fn group_key_matches_console_infra_sha256_and_ack_overlay_sets_lead_and_2h_changes() -> TestResult {
    let key = compute_group_key("HighLatency", "");
    assert_eq!(key.len(), 8);
    assert!(key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

    let now = datetime!(2026-11-20 02:00 UTC);
    let interval = NonZeroU64::new(60).ok_or("nonzero")?;
    let group = AlertGroupView {
        key: key.clone(),
        alertname: "HighLatency".into(),
        component: Observed::current("api".into(), None, "am".into(), now, now, interval),
        severity: Observed::current(Severity::Page, None, "am".into(), now, now, interval),
        state: Observed::current(AlertState::Firing, None, "am".into(), now, now, interval),
        since: Observed::current(
            UtcTimestamp::new(now),
            None,
            "am".into(),
            now,
            now,
            interval,
        ),
        members_n: Observed::current(1, None, "am".into(), now, now, interval),
        summary: Observed::current("Slow".into(), None, "am".into(), now, now, interval),
        value_vs_threshold: ValueVsThresholdView {
            value: Observed::unknown("vm".into(), "none".into()),
            threshold: Observed::unknown("vm".into(), "none".into()),
            operator: Observed::unknown("vm".into(), "none".into()),
        },
        lead: None,
    };
    let mut groups = AlertGroupsView {
        evaluated_at: now,
        groups: vec![group.clone()],
        count: Observed::current(1, None, "am".into(), now, now, interval),
        alert_count: Observed::current(1, None, "am".into(), now, now, interval),
    };
    let mut details = BTreeMap::from([(
        key.clone(),
        AlertGroupDetailView {
            summary_group: group,
            impact: Observed::unknown("am".into(), "none".into()),
            probable_cause: Observed::unknown("am".into(), "none".into()),
            first_action: Observed::unknown("am".into(), "none".into()),
            notices: vec![],
            rule: RuleView {
                expression: Observed::unknown("vm".into(), "none".into()),
                current_value: Observed::unknown("vm".into(), "none".into()),
            },
            members: vec![],
            changes: vec![],
            links: vec![],
            footer_key: key.clone(),
        },
    )]);
    let acks = vec![AlertAckRecord {
        seq: 1,
        hash: "h".into(),
        support_ref: "s1".into(),
        at: UtcTimestamp::new(now - Duration::minutes(5)),
        operator: "op-first".into(),
        group_key: key.clone(),
        alertname: "HighLatency".into(),
        component: "api".into(),
        note: None,
    }];
    let changes = vec![
        ChangeView {
            at: Observed::current(
                UtcTimestamp::new(now - Duration::minutes(30)),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
            summary: Observed::current(
                "Recent deploy".into(),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
        },
        ChangeView {
            at: Observed::current(
                UtcTimestamp::new(now - Duration::hours(3)),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
            summary: Observed::current("Old deploy".into(), None, "vm".into(), now, now, interval),
        },
    ];
    overlay_acks_and_changes(&mut groups, &mut details, &acks, &changes, now, interval);
    assert_eq!(groups.groups[0].state.value(), Some(&AlertState::Acked));
    assert_eq!(
        groups.groups[0]
            .lead
            .as_ref()
            .and_then(|l| l.value())
            .map(String::as_str),
        Some("op-first")
    );
    assert_eq!(details[&key].changes.len(), 1);
    Ok(())
}

#[test]
fn silence_writes_spool_first_and_records_outcome_on_am_failure() -> TestResult {
    let ack_store = MemAckStore(Mutex::new(vec![]));
    let silence_store = MemSilenceStore(Mutex::new(vec![]));
    let writer = MockWriter { fail: true };
    let svc = AlertActionsService {
        ack_store: &ack_store,
        silence_store: &silence_store,
        am_writer: &writer,
    };
    let now = datetime!(2026-11-20 00:00 UTC);
    let ctx = Context {
        at: now,
        operator: Operator {
            person: "op-1".into(),
            method: "access-jwt".into(),
        },
        support_ref: "sup-1".into(),
    };
    let groups = AlertGroupsView {
        evaluated_at: now,
        groups: vec![],
        count: Observed::unknown("am".into(), "none".into()),
        alert_count: Observed::unknown("am".into(), "none".into()),
    };
    let input = SilenceCreateInput {
        matchers: vec![SilenceMatcherInput {
            name: "alertname".into(),
            value: "HighLatency".into(),
            is_regex: false,
            is_equal: true,
        }],
        ends_at: "2026-11-20T01:00:00Z".into(),
        comment: "Valid reason >= 10 chars".into(),
        group_key: None,
    };
    let mut boxed = Box::pin(svc.create_silence(&input, &groups, &ctx));
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(waker);
    let res = match boxed.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(r) => r,
        std::task::Poll::Pending => return Err("unexpected pending".into()),
    };
    assert!(res.is_err());
    let records = silence_store.list_records().map_err(|e| format!("{e:?}"))?;
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].action, "silence_requested");
    assert_eq!(records[1].action, "silence_failed");
    Ok(())
}
