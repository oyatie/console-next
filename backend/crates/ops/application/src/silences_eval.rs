// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use time::OffsetDateTime;

use crate::snapshot::{
    AlertGroupDetailView, AlertGroupView, AlertGroupsView, MatcherView, SilenceView, SilencesView,
    ValueVsThresholdView,
};
use crate::sources_status::{SourceSlot, sanitize_text};
use crate::vmalert::RuleAlert;
use crate::{Alert, AlertState as SourceAlertState, AlertmanagerSnapshot, VmalertSnapshot};
use console_ops_domain::UtcTimestamp;
use console_ops_domain::alert_actions::{
    SilenceCreateInput, SilenceMatcherInput, SilenceValidationError,
};
use console_ops_domain::ladders::{AlertState, Severity};

pub fn build_silences(am: &SourceSlot<AlertmanagerSnapshot>, now: OffsetDateTime) -> SilencesView {
    let silences = am
        .current
        .as_ref()
        .map(|snap| {
            snap.silences
                .iter()
                .map(|s| SilenceView {
                    id: s.id.clone(),
                    matchers: s
                        .matchers
                        .iter()
                        .map(|m| MatcherView {
                            name: m.name.clone(),
                            value: m.value.clone(),
                            is_regex: m.is_regex,
                            is_equal: m.is_equal,
                        })
                        .collect(),
                    starts: am.observe(Some(UtcTimestamp::new(s.starts_at)), None, now),
                    ends: am.observe(Some(UtcTimestamp::new(s.ends_at)), None, now),
                    author: am.observe(sanitize_text(&s.created_by), None, now),
                    comment: am.observe(sanitize_text(&s.comment), None, now),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let count = am.observe(
        am.current.as_ref().map(|s| s.silences.len()),
        Some("count".into()),
        now,
    );
    SilencesView {
        evaluated_at: now,
        silences,
        count,
    }
}

pub fn alert_state(alert: &Alert) -> Option<AlertState> {
    match alert.status.state {
        SourceAlertState::Active => Some(AlertState::Firing),
        SourceAlertState::Unprocessed => None,
        SourceAlertState::Suppressed => {
            if !alert.status.silenced_by.is_empty() {
                Some(AlertState::Silenced)
            } else if !alert.status.inhibited_by.is_empty() {
                Some(AlertState::Inhibited)
            } else {
                None
            }
        }
    }
}

pub fn group_state(members: &[&Alert]) -> Option<AlertState> {
    if members
        .iter()
        .any(|a| matches!(a.status.state, SourceAlertState::Active))
    {
        Some(AlertState::Firing)
    } else if members
        .iter()
        .any(|a| matches!(a.status.state, SourceAlertState::Unprocessed))
    {
        None
    } else if members.iter().any(|a| !a.status.silenced_by.is_empty()) {
        Some(AlertState::Silenced)
    } else if members.iter().any(|a| !a.status.inhibited_by.is_empty()) {
        Some(AlertState::Inhibited)
    } else {
        None
    }
}

pub fn find_matching_rule_alert<'a>(
    vm: &'a SourceSlot<VmalertSnapshot>,
    alertname: &str,
    members: &[&Alert],
) -> Option<&'a RuleAlert> {
    let snap = vm.current.as_ref()?;
    let comp = members.first().and_then(|a| {
        a.labels
            .get("component")
            .or_else(|| a.labels.get("alertgroup"))
    });
    snap.alerts.iter().find(|ra| {
        ra.labels.get("alertname").map(String::as_str) == Some(alertname)
            && comp.is_none_or(|c| {
                ra.labels
                    .get("component")
                    .or_else(|| ra.labels.get("alertgroup"))
                    == Some(c)
            })
    })
}

pub fn parse_value_vs_threshold(
    vm: &SourceSlot<VmalertSnapshot>,
    rule: Option<&RuleAlert>,
    now: OffsetDateTime,
) -> ValueVsThresholdView {
    let val = rule.and_then(|r| r.value.parse::<f64>().ok().filter(|v| v.is_finite()));
    let (op, threshold) = rule.and_then(|r| extract_threshold(&r.expression)).unzip();
    ValueVsThresholdView {
        value: vm.observe(val, None, now),
        threshold: vm.observe(threshold, None, now),
        operator: vm.observe(op, None, now),
    }
}

fn extract_threshold(expr: &str) -> Option<(String, f64)> {
    for op in [">=", "<=", "==", "!=", ">", "<"] {
        if let Some((_, rhs)) = expr.rsplit_once(op)
            && let Some(token) = rhs.split_whitespace().next()
            && let Ok(num) = token.trim_end_matches([')', ']']).parse::<f64>()
            && num.is_finite()
        {
            return Some((op.to_owned(), num));
        }
    }
    None
}

pub fn group_matches_matchers(
    group: &AlertGroupView,
    detail: Option<&AlertGroupDetailView>,
    matchers: &[SilenceMatcherInput],
) -> bool {
    if matchers.is_empty() {
        return false;
    }
    let matcher_ok = |m: &SilenceMatcherInput, member_labels: Option<&BTreeMap<String, String>>| {
        if m.is_regex || !m.is_equal {
            return false;
        }
        let name = m.name.trim();
        let value = m.value.trim();
        if name.is_empty() || value.is_empty() {
            return false;
        }
        if let Some(labels) = member_labels
            && labels.get(name).map(String::as_str) == Some(value)
        {
            return true;
        }
        match name {
            "alertname" => group.alertname == value,
            "component" => group.component.value().map(String::as_str) == Some(value),
            _ => false,
        }
    };
    if let Some(d) = detail
        && !d.members.is_empty()
    {
        return d
            .members
            .iter()
            .any(|mem| matchers.iter().all(|m| matcher_ok(m, Some(&mem.labels))));
    }
    matchers.iter().all(|m| matcher_ok(m, None))
}

pub fn resolve_silence_target_severity(
    input: &SilenceCreateInput,
    groups: &AlertGroupsView,
    details: Option<&BTreeMap<String, AlertGroupDetailView>>,
) -> Result<Severity, SilenceValidationError> {
    if let Some(key) = input
        .group_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let Some(group) = groups.groups.iter().find(|g| g.key == key) else {
            return Err(SilenceValidationError::Invalid(
                "group_key does not match any active alert group".to_owned(),
            ));
        };
        let detail = details.and_then(|d| d.get(key));
        if !group_matches_matchers(group, detail, &input.matchers) {
            return Err(SilenceValidationError::Invalid(
                "group_key does not match silence matchers".to_owned(),
            ));
        }
    }

    let matching: Vec<&AlertGroupView> = groups
        .groups
        .iter()
        .filter(|g| {
            let detail = details.and_then(|d| d.get(&g.key));
            group_matches_matchers(g, detail, &input.matchers)
        })
        .collect();

    if !matching.is_empty()
        && matching
            .iter()
            .all(|g| g.severity.value() == Some(&Severity::Ticket))
    {
        Ok(Severity::Ticket)
    } else {
        Ok(Severity::Page)
    }
}
