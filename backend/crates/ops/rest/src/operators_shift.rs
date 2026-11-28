// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::UtcTimestamp;
use console_ops_domain::bundle::{OncallConfig, SHIFT_BOUND_ACTIONS};
use console_platform_authz::CedarEvaluation;
use console_platform_authz::cedar_pbac::engine::{CompiledBundle, evaluate_entities};
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::operators::{Grant, Refusal};

pub(crate) fn effective_grants_with_shift(
    person: Uuid,
    base: &[Grant],
    now: OffsetDateTime,
    oncall: Option<&OncallConfig>,
) -> Vec<Grant> {
    let mut effective_grants = base.to_vec();
    if let Some(shift) = oncall.and_then(|cfg| cfg.active_shift(now)) {
        let person_str = person.to_string();
        if shift.active_person.as_deref() == Some(person_str.as_str())
            && shift.shift_from <= now
            && now < shift.shift_until
        {
            let from = serde_json::to_value(UtcTimestamp::new(shift.shift_from))
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned));
            let until = serde_json::to_value(UtcTimestamp::new(shift.shift_until))
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned));
            if let (Some(from), Some(until)) = (from, until) {
                for &shift_action in SHIFT_BOUND_ACTIONS {
                    let exists = effective_grants
                        .iter()
                        .any(|g| g.action == shift_action && g.from == from && g.until == until);
                    if !exists {
                        effective_grants.push(Grant {
                            action: shift_action.to_owned(),
                            from: from.clone(),
                            until: until.clone(),
                        });
                    }
                }
            }
        }
    }
    effective_grants
}

pub(crate) fn timestamp(value: &str) -> Result<i64, String> {
    if !value.ends_with('Z') {
        return Err("expected a UTC timestamp ending in Z".to_owned());
    }
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|e| e.to_string())
        .and_then(|t| i64::try_from(t.unix_timestamp_nanos()).map_err(|e| e.to_string()))
}

#[derive(Serialize)]
struct Uid {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
}

#[derive(Serialize)]
struct Reference {
    #[serde(rename = "__entity")]
    uid: Uid,
}

#[derive(Serialize)]
struct CedarGrant {
    action: Reference,
    from: i64,
    until: i64,
}

#[derive(Serialize)]
struct Entity<T> {
    uid: Uid,
    attrs: T,
    parents: [Uid; 0],
}

#[derive(Serialize)]
struct Attributes<'a> {
    grants: &'a [CedarGrant],
}

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
struct Context<'a> {
    now: i64,
    grant: &'a CedarGrant,
}

fn uid(kind: &'static str, id: &str) -> Uid {
    Uid {
        kind,
        id: id.to_owned(),
    }
}

fn cedar_grant(grant: &Grant) -> Result<CedarGrant, Refusal> {
    Ok(CedarGrant {
        action: Reference {
            uid: uid("Ops::Action", &grant.action),
        },
        from: timestamp(&grant.from).map_err(|_| Refusal::ActionDenied)?,
        until: timestamp(&grant.until).map_err(|_| Refusal::ActionDenied)?,
    })
}

pub(crate) fn decide_with_grants(
    bundle: &CompiledBundle,
    person: Uuid,
    all_grants: &[Grant],
    selected: &Grant,
    action: &str,
    now: i64,
) -> Result<bool, Refusal> {
    let grants = all_grants
        .iter()
        .map(cedar_grant)
        .collect::<Result<Vec<_>, _>>()?;
    let entities = (
        Entity {
            uid: uid("Ops::Operator", &person.to_string()),
            attrs: Attributes { grants: &grants },
            parents: [],
        },
        Entity {
            uid: uid("Ops::Console", "ops"),
            attrs: Empty {},
            parents: [],
        },
    );
    let context = Context {
        now,
        grant: &cedar_grant(selected)?,
    };
    let json_action = serde_json::to_string(action).map_err(|_| Refusal::ActionDenied)?;
    match evaluate_entities(
        bundle,
        &format!("Ops::Operator::\"{person}\""),
        &format!("Ops::Action::{json_action}"),
        "Ops::Console::\"ops\"",
        serde_json::to_value(entities).map_err(|_| Refusal::ActionDenied)?,
        serde_json::to_value(context).map_err(|_| Refusal::ActionDenied)?,
    ) {
        CedarEvaluation::Allow { .. } => Ok(true),
        CedarEvaluation::Deny { .. } => Ok(false),
        CedarEvaluation::Error { .. } | CedarEvaluation::NotConfigured => {
            Err(Refusal::ActionDenied)
        }
    }
}
