// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use super::{privacy_request_decide, privacy_request_file};
use crate::cedar_pbac::action_schema::ActionSchema;
use cedar_policy::{Authorizer, Context, Decision, Entities, PolicySet, Request, Schema};
use serde_json::{Value, json};

fn evaluate(
    spec: ActionSchema,
    resource_org: &str,
    facts: Value,
) -> Result<(bool, Vec<String>), String> {
    let schema: Schema = spec.cedar_schema().parse().map_err(|e| format!("{e}"))?;
    let policies: PolicySet = spec.policies.parse().map_err(|e| format!("{e}"))?;
    let entities = Entities::from_json_value(
        json!([
            {"uid":{"type":"Subject","id":"actor"},"attrs":{
                "org":"org","roles":["SUPER_ADMIN"],"is_tenant_ops":true,
                "subject_version":1,"clearance_keys":[]},"parents":[]},
            {"uid":{"type":"Resource","id":"request"},"attrs":{
                "org":resource_org,"resource_type":"privacy_request"},"parents":[]}
        ]),
        Some(&schema),
    )
    .map_err(|e| e.to_string())?;
    let context = Context::from_json_value(
        facts,
        Some((
            &schema,
            &format!("Action::\"{}\"", spec.feature.as_str())
                .parse()
                .unwrap(),
        )),
    )
    .map_err(|e| e.to_string())?;
    let request = Request::new(
        "Subject::\"actor\"".parse().unwrap(),
        format!("Action::\"{}\"", spec.feature.as_str())
            .parse()
            .unwrap(),
        "Resource::\"request\"".parse().unwrap(),
        context,
        Some(&schema),
    )
    .map_err(|e| e.to_string())?;
    let response = Authorizer::new().is_authorized(&request, &policies, &entities);
    assert_eq!(response.diagnostics().errors().count(), 0);
    let reasons = response
        .diagnostics()
        .reason()
        .filter_map(|id| policies.policy(id)?.annotation("reason").map(str::to_owned))
        .collect();
    Ok((response.decision() == Decision::Allow, reasons))
}
fn independent_holder() -> Value {
    json!({"actor_is_requester":false,"actor_contributed":false,
        "actor_decided_original":false,"actor_holds_permission":true})
}
#[test]
fn privacy_decision_forbids_the_subject_filer_and_original_decider_even_for_ops() {
    let spec = privacy_request_decide::SCHEMA;
    for (fact, reason) in [
        ("actor_is_requester", "own_request_forbidden"),
        ("actor_contributed", "own_request_forbidden"),
        ("actor_decided_original", "objection_same_decider"),
    ] {
        let mut facts = independent_holder();
        facts[fact] = json!(true);
        let (allowed, reasons) = evaluate(spec, "org", facts).unwrap();
        assert!(!allowed);
        assert!(reasons.contains(&reason.to_owned()));
    }
}
#[test]
fn privacy_decision_needs_live_permission_same_tenant_and_every_fact() {
    let spec = privacy_request_decide::SCHEMA;
    spec.compile(console_kernel_core::OrgId::new(), 1, spec.policies)
        .unwrap();
    assert!(evaluate(spec, "org", independent_holder()).unwrap().0);
    assert!(!evaluate(spec, "foreign", independent_holder()).unwrap().0);
    let mut denied = independent_holder();
    denied["actor_holds_permission"] = json!(false);
    assert!(!evaluate(spec, "org", denied).unwrap().0);
    for fact in spec.facts {
        let mut incomplete = independent_holder();
        incomplete.as_object_mut().unwrap().remove(fact.name);
        assert!(evaluate(spec, "org", incomplete).is_err());
    }
}
#[test]
fn privacy_filing_is_self_only_and_hr_requires_a_linked_employee() {
    let spec = privacy_request_file::SCHEMA;
    spec.compile(console_kernel_core::OrgId::new(), 1, spec.policies)
        .unwrap();
    for is_hr in [false, true] {
        for has_employee in [false, true] {
            for is_self in [false, true] {
                let facts =
                    json!({"actor_is_requester":is_self,"is_hr":is_hr,"has_employee":has_employee});
                assert_eq!(
                    evaluate(spec, "org", facts.clone()).unwrap().0,
                    is_self && (!is_hr || has_employee)
                );
                assert!(!evaluate(spec, "foreign", facts.clone()).unwrap().0);
                for fact in spec.facts {
                    let mut incomplete = facts.clone();
                    incomplete.as_object_mut().unwrap().remove(fact.name);
                    assert!(evaluate(spec, "org", incomplete).is_err());
                }
            }
        }
    }
}
