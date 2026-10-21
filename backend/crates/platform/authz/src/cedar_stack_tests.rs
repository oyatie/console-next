use crate::cedar_pbac::actions::ActionBundle;

const ACTION: &str = "stack_probe";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action stack_probe appliesTo {
  principal: [Subject], resource: [Resource], context: {}
};"#;

fn decide(policy: &str) -> Result<bool, String> {
    ActionBundle::compile(ACTION, SCHEMA, policy)?.decide("actor", "org", &[], "org", &[])
}

#[test]
fn policy_allows_on_constrained_worker_stacks() {
    let predicate = "principal.org == resource.org";
    let expression = (0..32).fold(predicate.to_owned(), |nested, _| {
        format!("{predicate} && ({nested})")
    });
    let policy = format!(
        "permit(principal, action == Action::\"{ACTION}\", resource) when {{ {expression} }};"
    );
    assert_eq!(decide(&policy), Ok(true), "normal-stack control");
    for stack_kib in [128, 768, 1024, 1536] {
        let policy = policy.clone();
        let decision = std::thread::Builder::new()
            .name("cedar-constrained-stack".into())
            .stack_size(stack_kib * 1024)
            .spawn(move || decide(&policy))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(
            decision,
            Ok(true),
            "same policy on a {stack_kib} KiB worker stack"
        );
    }
}
