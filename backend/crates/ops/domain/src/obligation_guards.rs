// SPDX-License-Identifier: LicenseRef-Proprietary
use time::OffsetDateTime;

use crate::obligation::{Kind, Obligation, Refusal};
use crate::{Health, Verdict};

pub(crate) fn present(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|value| !value.trim().is_empty())
}

pub fn is_structured_counsel_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
        || trimmed.contains("..")
    {
        return false;
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        let Some((host, path)) = rest.split_once('/') else {
            return false;
        };
        return !host.is_empty()
            && (host.contains('.') || host.starts_with("localhost"))
            && !path.is_empty();
    }
    if let Some(rest) = trimmed
        .strip_prefix("docs/")
        .or_else(|| trimmed.strip_prefix("ops/"))
    {
        return !rest.is_empty() && !rest.starts_with('/');
    }
    false
}

fn distinct_signers(primary: &Option<String>, secondary: &Option<String>) -> bool {
    match (primary.as_deref(), secondary.as_deref()) {
        (Some(a), Some(b)) => !a.trim().eq_ignore_ascii_case(b.trim()),
        _ => true,
    }
}

pub(crate) fn validate_done(
    kind: Kind,
    evidence_ref: &Option<String>,
    signer: &Option<String>,
    co_signer: &Option<String>,
    counsel_url: &Option<String>,
) -> Result<(), Refusal> {
    if kind == Kind::LaunchGate {
        if !present(co_signer) {
            return Err(Refusal::Incomplete);
        }
        let structured_ok = if present(counsel_url) {
            counsel_url
                .as_deref()
                .is_some_and(is_structured_counsel_url)
        } else {
            evidence_ref
                .as_deref()
                .is_some_and(is_structured_counsel_url)
        };
        if !distinct_signers(signer, co_signer) || !structured_ok {
            return Err(Refusal::Invalid);
        }
    } else {
        if present(co_signer) && !distinct_signers(signer, co_signer) {
            return Err(Refusal::Invalid);
        }
        if present(counsel_url)
            && !counsel_url
                .as_deref()
                .is_some_and(is_structured_counsel_url)
        {
            return Err(Refusal::Invalid);
        }
    }
    Ok(())
}

pub(crate) fn validate_waived(
    kind: Kind,
    signer: &Option<String>,
    co_signer: &Option<String>,
    counsel_url: &Option<String>,
) -> Result<(), Refusal> {
    if kind == Kind::LaunchGate {
        if !present(co_signer) || !present(counsel_url) {
            return Err(Refusal::Incomplete);
        }
        if !distinct_signers(signer, co_signer)
            || !counsel_url
                .as_deref()
                .is_some_and(is_structured_counsel_url)
        {
            return Err(Refusal::Invalid);
        }
    } else {
        if present(co_signer) && !distinct_signers(signer, co_signer) {
            return Err(Refusal::Invalid);
        }
        if present(counsel_url)
            && !counsel_url
                .as_deref()
                .is_some_and(is_structured_counsel_url)
        {
            return Err(Refusal::Invalid);
        }
    }
    Ok(())
}

/// Call only after obligation.read is allowed, passing the verified source or its failure reason.
pub fn launch_readiness(source: Result<&[Obligation], &str>) -> Verdict {
    let items = match source {
        Ok(items) => items,
        Err(reason) => {
            return Verdict {
                text: format!("Unknown: {reason}"),
                worst: Health::Unknown,
            };
        }
    };
    let gates: Vec<_> = items
        .iter()
        .filter(|item| item.kind() == Kind::LaunchGate)
        .collect();
    let open = gates.iter().filter(|item| item.is_open()).count();
    if gates.is_empty() {
        Verdict {
            text: "Unknown: no launch gates recorded".into(),
            worst: Health::Unknown,
        }
    } else if open > 0 {
        Verdict {
            text: format!("Blocked: {} open", crate::count_text(open, "launch gate")),
            worst: Health::Degraded,
        }
    } else {
        Verdict {
            text: format!(
                "Ready: all {} done or waived (signed)",
                crate::count_text(gates.len(), "launch gate")
            ),
            worst: Health::Healthy,
        }
    }
}

/// Input must be chain-verified and Cedar-authorized before computing any worklist or count.
pub fn worklist(items: &[Obligation], now: OffsetDateTime, due_soon_days: u32) -> Vec<&Obligation> {
    let mut keyed: Vec<_> = items
        .iter()
        .filter_map(|item| item.worklist_key(now, due_soon_days).map(|key| (key, item)))
        .collect();
    keyed.sort_by_key(|(key, _)| *key);
    keyed.into_iter().map(|(_, item)| item).collect()
}
