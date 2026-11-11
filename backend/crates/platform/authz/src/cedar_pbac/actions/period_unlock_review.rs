// SPDX-License-Identifier: LicenseRef-Proprietary
//! Live close entitlement and independent review, shared by inbox and acknowledgement.
use super::{ActionBundle, Fact};
use crate::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::visible::load_facts,
};
use console_kernel_core::{KernelError, OrgId};
use std::{collections::BTreeMap, sync::OnceLock};
use uuid::Uuid;

const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action period_unlock_review appliesTo { principal: [Subject], resource: [Resource],
 context: { "entitled": Bool, "own": Bool, "another": Bool } };"#;
const POLICY: &str = r#"permit(principal, action == Action::"period_unlock_review", resource)
when { principal.org == resource.org && context.entitled && (!context.own || !context.another) };"#;

fn decide(
    actor: Uuid,
    org: OrgId,
    entitled: bool,
    own: bool,
    another: bool,
) -> Result<bool, KernelError> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("period_unlock_review", SCHEMA, POLICY))
        .as_ref()
        .map_err(|e| KernelError::internal(e.clone()))?
        .decide(
            &actor.to_string(),
            &org.to_string(),
            &[],
            &org.to_string(),
            &[
                ("entitled", Fact::Bool(entitled)),
                ("own", Fact::Bool(own)),
                ("another", Fact::Bool(another)),
            ],
        )
        .map_err(KernelError::internal)
}

pub struct Reviewers {
    org: OrgId,
    people: BTreeMap<Uuid, Uuid>,
}

impl Reviewers {
    pub fn allows(
        &self,
        actor: Uuid,
        requester: Uuid,
        person: Option<Uuid>,
    ) -> Result<bool, KernelError> {
        let maker = person.unwrap_or(requester);
        decide(
            actor,
            self.org,
            self.people.contains_key(&actor),
            actor == requester || self.people.get(&actor) == Some(&maker),
            self.people.values().any(|p| *p != maker),
        )
    }
}

pub async fn load(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
) -> Result<Reviewers, KernelError> {
    let accounts: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT id,person_id FROM users WHERE org_id=$1 AND is_active ORDER BY id FOR SHARE",
    )
    .bind(org.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(|e| KernelError::internal(e.to_string()))?;
    let mut people = BTreeMap::new();
    for (actor, person) in accounts {
        let facts = load_facts(tx, org, actor).await?;
        let entitled = facts
            .authorize(
                Feature::PeriodLockManage.as_str(),
                NodeRef {
                    kind: NodeKind::Tenant,
                    id: *org.as_uuid(),
                },
            )
            .map_err(|e| KernelError::internal(e.to_string()))?;
        if decide(actor, org, entitled, false, false)? {
            people.insert(actor, person.unwrap_or(actor));
        }
    }
    Ok(Reviewers { org, people })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn entitlement_and_independence_are_required_unless_alone() {
        for entitled in [false, true] {
            for own in [false, true] {
                for another in [false, true] {
                    assert_eq!(
                        decide(Uuid::nil(), OrgId::one(), entitled, own, another).unwrap(),
                        entitled && (!own || !another)
                    );
                }
            }
        }
        let bundle = ActionBundle::compile("period_unlock_review", SCHEMA, POLICY).unwrap();
        assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
        assert_eq!(
            bundle.decide(
                "u",
                "o",
                &[],
                "other",
                &[
                    ("entitled", Fact::Bool(true)),
                    ("own", Fact::Bool(false)),
                    ("another", Fact::Bool(false))
                ]
            ),
            Ok(false)
        );
        let actor = Uuid::from_u128(1);
        let alias = Uuid::from_u128(2);
        let other = Uuid::from_u128(3);
        let person = Uuid::from_u128(4);
        let mut reviewers = Reviewers {
            org: OrgId::one(),
            people: BTreeMap::from([(actor, person), (alias, person), (other, other)]),
        };
        assert!(!reviewers.allows(alias, actor, Some(person)).unwrap());
        reviewers.people.remove(&other);
        assert!(reviewers.allows(alias, actor, Some(person)).unwrap());
    }
}
