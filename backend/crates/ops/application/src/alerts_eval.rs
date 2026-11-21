// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};

use console_ops_domain::ladders::{EvidenceState, Severity};
use console_ops_domain::{Observed, UtcTimestamp};
use time::OffsetDateTime;

use crate::silences_eval::{
    alert_state, build_silences, find_matching_rule_alert, group_state, parse_value_vs_threshold,
};
use crate::snapshot::{
    AlertGroupDetailView, AlertGroupView, AlertGroupsView, AlertMemberView, RuleView, SilencesView,
};
use crate::sources_status::{SourceSlot, sanitize_text};
use crate::vmalert::RuleAlertState;
use crate::{Alert, AlertmanagerSnapshot, VmalertSnapshot};

pub fn evaluate_alerts(
    am: &SourceSlot<AlertmanagerSnapshot>,
    vm: &SourceSlot<VmalertSnapshot>,
    known_groups: &BTreeMap<String, String>,
    now: OffsetDateTime,
) -> (
    AlertGroupsView,
    BTreeMap<String, AlertGroupDetailView>,
    SilencesView,
    Option<String>,
) {
    let am_source = am.source_view(now);
    let vm_source = vm.source_view(now);
    let vmalert_firing = vm.current.as_ref().is_some_and(|snap| {
        vm_source.state == EvidenceState::Verified
            && snap
                .alerts
                .iter()
                .any(|a| matches!(a.state, RuleAlertState::Firing))
    });
    let am_empty = am.current.as_ref().is_some_and(|s| s.alerts.is_empty());
    let disagreement = (am_source.state == EvidenceState::Verified && am_empty && vmalert_firing)
        .then(|| "alertmanager empty while vmalert firing".to_owned());

    let mut grouped: BTreeMap<String, (String, Vec<&Alert>)> = BTreeMap::new();
    if am.current.is_some() {
        for alert in am.current.iter().flat_map(|s| &s.alerts) {
            let ident = group_identity(alert);
            let key = format!(
                "{}×{}",
                ident.0.replace('%', "%25").replace('×', "%C3%97"),
                ident.1.replace('%', "%25").replace('×', "%C3%97")
            );
            grouped
                .entry(key)
                .or_insert_with(|| (ident.0, Vec::new()))
                .1
                .push(alert);
        }
    } else {
        for (key, alertname) in known_groups {
            grouped.insert(key.clone(), (alertname.clone(), Vec::new()));
        }
    }

    let mut groups = Vec::with_capacity(grouped.len());
    let mut details = BTreeMap::new();
    for (key, (alertname, members)) in &grouped {
        let group = build_group(am, vm, key, alertname, members, now);
        details.insert(key.clone(), build_detail(am, vm, &group, members, now));
        groups.push(group);
    }

    let (count, alert_count) = match &disagreement {
        Some(reason) => (
            Observed::unknown(am.producer.clone(), reason.clone()),
            Observed::unknown(am.producer.clone(), reason.clone()),
        ),
        None => (
            am.observe(
                am.current.as_ref().map(|_| groups.len()),
                Some("count".into()),
                now,
            ),
            am.observe(
                am.current.as_ref().map(|s| s.alerts.len()),
                Some("count".into()),
                now,
            ),
        ),
    };

    let silences = build_silences(am, now);
    (
        AlertGroupsView {
            evaluated_at: now,
            groups,
            count,
            alert_count,
        },
        details,
        silences,
        disagreement,
    )
}

fn build_group(
    am: &SourceSlot<AlertmanagerSnapshot>,
    vm: &SourceSlot<VmalertSnapshot>,
    key: &str,
    alertname: &str,
    members: &[&Alert],
    now: OffsetDateTime,
) -> AlertGroupView {
    let component = member_field(am, members, "component", false, now);
    let raw_severity = member_field(am, members, "severity", false, now);
    let severity = match raw_severity.value().map(String::as_str) {
        Some("page") => am.observe(Some(Severity::Page), None, now),
        Some("ticket") => am.observe(Some(Severity::Ticket), None, now),
        Some(other) => Observed::unknown(
            am.producer.clone(),
            format!("severity {other} not on the ladder"),
        ),
        None => Observed::unknown(
            am.producer.clone(),
            raw_severity.reason().unwrap_or("not instrumented").into(),
        ),
    };
    let state = am.observe(group_state(members), None, now);
    let earliest = members.iter().map(|a| UtcTimestamp::new(a.starts_at)).min();
    let since = am.observe(earliest, None, now);
    let members_n = am.observe(Some(members.len()), None, now);
    let summary = member_field(am, members, "summary", true, now);
    let matching_rule = find_matching_rule_alert(vm, alertname, members);
    let value_vs_threshold = parse_value_vs_threshold(vm, matching_rule, now);

    AlertGroupView {
        key: key.to_owned(),
        alertname: alertname.to_owned(),
        component,
        severity,
        state,
        since,
        members_n,
        summary,
        value_vs_threshold,
        lead: None,
    }
}

fn build_detail(
    am: &SourceSlot<AlertmanagerSnapshot>,
    vm: &SourceSlot<VmalertSnapshot>,
    group: &AlertGroupView,
    members: &[&Alert],
    now: OffsetDateTime,
) -> AlertGroupDetailView {
    let impact = member_field(am, members, "impact", true, now);
    let probable_cause = member_field(am, members, "probable_cause", true, now);
    let first_action = member_field(am, members, "first_action", true, now);
    let matching_rule = find_matching_rule_alert(vm, &group.alertname, members);
    let rule = RuleView {
        expression: vm.observe(matching_rule.map(|r| r.expression.clone()), None, now),
        current_value: vm.observe(
            matching_rule.and_then(|r| r.value.parse::<f64>().ok().filter(|v| v.is_finite())),
            None,
            now,
        ),
    };
    let member_views = members
        .iter()
        .map(|alert| AlertMemberView {
            fingerprint: alert.fingerprint.clone(),
            labels: alert.labels.clone(),
            state: am.observe(alert_state(alert), None, now),
            since: am.observe(Some(UtcTimestamp::new(alert.starts_at)), None, now),
        })
        .collect();
    let mut links = Vec::new();
    for key in ["runbook_url", "runbook"] {
        if let Some(val) = members
            .iter()
            .filter_map(|a| a.annotations.get(key))
            .find_map(|v| sanitize_text(v))
        {
            links.push(am.observe(Some(val), None, now));
        }
    }
    let notices = members
        .iter()
        .filter_map(|a| a.annotations.get("notice"))
        .filter_map(|v| sanitize_text(v))
        .map(|v| am.observe(Some(v), None, now))
        .collect();

    AlertGroupDetailView {
        summary_group: group.clone(),
        impact,
        probable_cause,
        first_action,
        notices,
        rule,
        members: member_views,
        changes: Vec::new(),
        links,
        footer_key: group.key.clone(),
    }
}

pub fn group_key(alert: &Alert) -> (String, String) {
    let ident = group_identity(alert);
    let key = format!(
        "{}×{}",
        ident.0.replace('%', "%25").replace('×', "%C3%97"),
        ident.1.replace('%', "%25").replace('×', "%C3%97")
    );
    (key, ident.0)
}

fn group_identity(alert: &Alert) -> (String, String) {
    let label = |name: &str| alert.labels.get(name).and_then(|v| sanitize_text(v));
    (
        label("alertname").unwrap_or_default(),
        label("component")
            .or_else(|| label("job"))
            .unwrap_or_default(),
    )
}

fn member_field(
    am: &SourceSlot<AlertmanagerSnapshot>,
    members: &[&Alert],
    name: &str,
    annotation: bool,
    now: OffsetDateTime,
) -> Observed<String> {
    let values: BTreeSet<Option<String>> = members
        .iter()
        .map(|alert| {
            let map = if annotation {
                &alert.annotations
            } else {
                &alert.labels
            };
            map.get(name).and_then(|v| sanitize_text(v))
        })
        .collect();
    if values.len() > 1 {
        Observed::unknown(am.producer.clone(), "members disagree".to_owned())
    } else {
        am.observe(values.into_iter().next().flatten(), None, now)
    }
}
