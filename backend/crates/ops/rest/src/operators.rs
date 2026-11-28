// SPDX-License-Identifier: LicenseRef-Proprietary
use aws_lc_rs::constant_time::verify_slices_are_equal;
use aws_lc_rs::digest::{SHA256, digest};
use console_kernel_core::OrgId;
use console_ops_domain::bundle::OncallConfig;
use console_platform_authz::cedar_pbac::engine::{CompiledBundle, compile_bundle_from_sources};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::operators_shift::{decide_with_grants, effective_grants_with_shift, timestamp};
pub use crate::valid_actions::VALID_ACTIONS;

#[derive(Debug, Clone)]
pub struct AuthorizedMatch {
    pub person: Uuid,
    pub grants: Vec<Grant>,
}

#[derive(Debug)]
pub struct Operator {
    pub person: Uuid,
    email_sha256: [u8; 32],
    pub grants: Vec<Grant>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOperator {
    person: Uuid,
    email_sha256: String,
    grants: Vec<Grant>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
        let raw_operators: Vec<RawOperator> =
            serde_json::from_str(source).map_err(|e| e.to_string())?;
        let bundle = compile_bundle_from_sources(
            OrgId::one(),
            1,
            "ops-v1",
            include_str!("../cedar/ops.cedarschema"),
            include_str!("../cedar/ops.cedar"),
        )
        .map_err(|e| e.to_string())?;
        let mut operators: Vec<Operator> = Vec::with_capacity(raw_operators.len());
        for (index, raw) in raw_operators.into_iter().enumerate() {
            if raw.email_sha256.len() != 64
                || !raw
                    .email_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(format!(
                    "/{index}/email_sha256: expected a lowercase SHA-256 hash"
                ));
            }
            let mut email_sha256 = [0u8; 32];
            hex::decode_to_slice(&raw.email_sha256, &mut email_sha256)
                .map_err(|_| format!("/{index}/email_sha256: expected a lowercase SHA-256 hash"))?;
            if operators.iter().any(|previous| {
                previous.person == raw.person
                    || verify_slices_are_equal(&previous.email_sha256, &email_sha256).is_ok()
            }) {
                return Err(format!("/{index}: duplicate operator identity"));
            }
            let operator = Operator {
                person: raw.person,
                email_sha256,
                grants: raw.grants,
            };
            for (grant_index, grant) in operator.grants.iter().enumerate() {
                let path = format!("/{index}/grants/{grant_index}");
                let from = timestamp(&grant.from).map_err(|e| format!("{path}/from: {e}"))?;
                timestamp(&grant.until).map_err(|e| format!("{path}/until: {e}"))?;
                // Validate the complete entity set even when no grant is live now.
                decide(&bundle, &operator, grant, &grant.action, from)
                    .map_err(|_| format!("{path}: invalid Cedar facts"))?;
            }
            operators.push(operator);
        }
        Ok(Self { operators, bundle })
    }

    pub fn person_ids(&self) -> Vec<String> {
        self.operators
            .iter()
            .map(|op| op.person.to_string())
            .collect()
    }

    pub fn authorize(
        &self,
        verified_email: &str,
        action: &str,
        now: OffsetDateTime,
    ) -> Result<&Operator, Refusal> {
        let matched = self.authorize_with_shift(verified_email, action, now, None)?;
        self.operators
            .iter()
            .find(|op| op.person == matched.person)
            .ok_or(Refusal::NotOperator)
    }

    pub fn authorize_with_shift(
        &self,
        verified_email: &str,
        action: &str,
        now: OffsetDateTime,
        oncall: Option<&OncallConfig>,
    ) -> Result<AuthorizedMatch, Refusal> {
        let hash = digest(&SHA256, verified_email.trim().to_lowercase().as_bytes());
        let operator = self
            .operators
            .iter()
            .fold(None, |matched, operator| {
                if verify_slices_are_equal(&operator.email_sha256, hash.as_ref()).is_ok() {
                    Some(operator)
                } else {
                    matched
                }
            })
            .ok_or(Refusal::NotOperator)?;

        let effective_grants =
            effective_grants_with_shift(operator.person, &operator.grants, now, oncall);

        let mut allowed = false;
        let mut live = false;
        let now_ns =
            i64::try_from(now.unix_timestamp_nanos()).map_err(|_| Refusal::ActionDenied)?;
        for grant in &effective_grants {
            allowed |= decide_with_grants(
                &self.bundle,
                operator.person,
                &effective_grants,
                grant,
                action,
                now_ns,
            )?;
            live |= decide_with_grants(
                &self.bundle,
                operator.person,
                &effective_grants,
                grant,
                &grant.action,
                now_ns,
            )?;
        }
        if allowed {
            Ok(AuthorizedMatch {
                person: operator.person,
                grants: effective_grants,
            })
        } else if live {
            Err(Refusal::ActionDenied)
        } else {
            Err(Refusal::GrantNotLive)
        }
    }
}

fn decide(
    bundle: &CompiledBundle,
    operator: &Operator,
    selected: &Grant,
    action: &str,
    now: i64,
) -> Result<bool, Refusal> {
    decide_with_grants(
        bundle,
        operator.person,
        &operator.grants,
        selected,
        action,
        now,
    )
}
