// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::OrgId;
use console_platform_authz::CedarEvaluation;
use console_platform_authz::cedar_pbac::engine::{
    CompiledBundle, compile_bundle_from_sources, evaluate_entities,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operator {
    pub person: Uuid,
    email_sha256: String,
    pub grants: Vec<Grant>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub action: String,
    pub from: String,
    pub until: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum Refusal {
    #[serde(rename = "OPS_NOT_OPERATOR")]
    NotOperator,
    #[serde(rename = "OPS_GRANT_NOT_LIVE")]
    GrantNotLive,
    #[serde(rename = "OPS_ACTION_DENIED")]
    ActionDenied,
}

/// The sole fact loader for the server-loaded operators.json; callers supply
/// an email only after Access JWT verification, never from request parameters.
pub struct OperatorRegistry {
    operators: Vec<Operator>,
    bundle: CompiledBundle,
}

impl OperatorRegistry {
    pub fn from_json(source: &str) -> Result<Self, String> {
        let operators: Vec<Operator> = serde_json::from_str(source).map_err(|e| e.to_string())?;
        let bundle = compile_bundle_from_sources(
            OrgId::one(),
            1,
            "ops-v1",
            include_str!("../cedar/ops.cedarschema"),
            include_str!("../cedar/ops.cedar"),
        )
        .map_err(|e| e.to_string())?;
        for (index, operator) in operators.iter().enumerate() {
            if operator.email_sha256.len() != 64
                || !operator
                    .email_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(format!(
                    "/{index}/email_sha256: expected a lowercase SHA-256 hash"
                ));
            }
            if operators[..index].iter().any(|previous| {
                previous.person == operator.person || previous.email_sha256 == operator.email_sha256
            }) {
                return Err(format!("/{index}: duplicate operator identity"));
            }
            for (grant_index, grant) in operator.grants.iter().enumerate() {
                let path = format!("/{index}/grants/{grant_index}");
                let from = timestamp(&grant.from).map_err(|e| format!("{path}/from: {e}"))?;
                timestamp(&grant.until).map_err(|e| format!("{path}/until: {e}"))?;
                // Validate the complete entity set even when no grant is live now.
                decide(&bundle, operator, grant, &grant.action, from)
                    .map_err(|_| format!("{path}: invalid Cedar facts"))?;
            }
        }
        Ok(Self { operators, bundle })
    }

    pub fn authorize(
        &self,
        verified_email: &str,
        action: &str,
        now: OffsetDateTime,
    ) -> Result<&Operator, Refusal> {
        let hash = hex::encode(Sha256::digest(verified_email.to_lowercase().as_bytes()));
        let operator = self
            .operators
            .iter()
            .find(|operator| operator.email_sha256 == hash)
            .ok_or(Refusal::NotOperator)?;
        let mut allowed = false;
        let mut live = false;
        let now = i64::try_from(now.unix_timestamp_nanos()).map_err(|_| Refusal::ActionDenied)?;
        for grant in &operator.grants {
            allowed |= decide(&self.bundle, operator, grant, action, now)?;
            live |= decide(&self.bundle, operator, grant, &grant.action, now)?;
        }
        if allowed {
            Ok(operator)
        } else if live {
            Err(Refusal::ActionDenied)
        } else {
            Err(Refusal::GrantNotLive)
        }
    }
}

fn timestamp(value: &str) -> Result<i64, String> {
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

fn decide(
    bundle: &CompiledBundle,
    operator: &Operator,
    selected: &Grant,
    action: &str,
    now: i64,
) -> Result<bool, Refusal> {
    let grants = operator
        .grants
        .iter()
        .map(cedar_grant)
        .collect::<Result<Vec<_>, _>>()?;
    let entities = (
        Entity {
            uid: uid("Ops::Operator", &operator.person.to_string()),
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
        &format!("Ops::Operator::\"{}\"", operator.person),
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
