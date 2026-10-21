//! `lifecycle_item_complete_{doc,fil,not,pay,back,acc,rec}`: who completes a
//! lifecycle case item (lifecycle-events.md §5.5, L7). One action per item
//! kind, each with its own strict schema and its own permit/forbid (D0.1 §3:
//! rules are emitted per action). Every fact is required and server-computed
//! under `FOR UPDATE` on the case (D0.1 §4); a missing fact denies.
//!
//! - The owner line comes from the item (the template row), never from here:
//!   the adapter computes `actor_holds_owner_line` against it.
//! - Nobody completes an item of their own case (`self_completion`); the DB
//!   trigger on `lifecycle_case_items.done_by` is the backstop until promotion.
//!
//! No REST calls this yet (LC-B4 wires it); the decision is shadow-ready.

use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const SCHEMA_VERSION: &str = "2026-10-lifecycle-item-complete-v1";

/// `(item kind, action)`, one action per kind (§3 column keys).
pub const ACTIONS: [(&str, &str); 7] = [
    ("DOC", "lifecycle_item_complete_doc"),
    ("FIL", "lifecycle_item_complete_fil"),
    ("NOT", "lifecycle_item_complete_not"),
    ("PAY", "lifecycle_item_complete_pay"),
    ("BACK", "lifecycle_item_complete_back"),
    ("ACC", "lifecycle_item_complete_acc"),
    ("REC", "lifecycle_item_complete_rec"),
];

/// Server-computed facts. Never taken from the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemCompleteFacts {
    /// The item's kind as stored; must match the action's kind.
    pub item_kind: String,
    /// The actor holds the item's owner line (domain × level).
    pub actor_holds_owner_line: bool,
    /// The actor's scope covers the case's 법인 / 사업장 / branch.
    pub actor_scope_covers: bool,
    /// The case's subject has a user account.
    pub has_subject_user: bool,
    /// The actor is that account (the nil id never matches).
    pub subject_is_self: bool,
}

fn schema(action: &str) -> String {
    format!(
        r#"entity Subject = {{ "org": String, "roles": Set<String> }};
entity Resource = {{ "org": String }};
action {action} appliesTo {{
  principal: [Subject],
  resource: [Resource],
  context: {{
    "item_kind": String,
    "actor_holds_owner_line": Bool,
    "actor_scope_covers": Bool,
    "has_subject_user": Bool,
    "subject_is_self": Bool
  }}
}};
"#
    )
}

fn policies(kind: &str, action: &str) -> String {
    format!(
        r#"permit (principal, action == Action::"{action}", resource)
when {{
  principal.org == resource.org && context.item_kind == "{kind}"
  && context.actor_holds_owner_line && context.actor_scope_covers
}};
@reason("self_completion")
forbid (principal, action == Action::"{action}", resource)
when {{ context.has_subject_user && context.subject_is_self }};
"#
    )
}

fn bundles() -> Result<&'static [ActionBundle], String> {
    static BUNDLES: OnceLock<Result<Vec<ActionBundle>, String>> = OnceLock::new();
    BUNDLES
        .get_or_init(|| {
            ACTIONS
                .iter()
                .map(|(kind, action)| {
                    ActionBundle::compile(action, &schema(action), &policies(kind, action))
                })
                .collect()
        })
        .as_ref()
        .map(Vec::as_slice)
        .map_err(Clone::clone)
}

/// Cedar's answer for completing an item of kind `kind`. An unknown kind, a
/// compile error or an evaluation error is a deny (`Err`).
///
/// # Errors
/// The kind is not one of [`ACTIONS`], or Cedar could not decide cleanly.
pub fn decide(
    kind: &str,
    principal: &str,
    org: &str,
    resource_org: &str,
    f: &ItemCompleteFacts,
) -> Result<bool, String> {
    let index = ACTIONS
        .iter()
        .position(|(k, _)| *k == kind)
        .ok_or_else(|| format!("lifecycle_item_kind_unknown: {kind:?}"))?;
    let facts = [
        ("item_kind", Fact::Str(f.item_kind.clone())),
        (
            "actor_holds_owner_line",
            Fact::Bool(f.actor_holds_owner_line),
        ),
        ("actor_scope_covers", Fact::Bool(f.actor_scope_covers)),
        ("has_subject_user", Fact::Bool(f.has_subject_user)),
        ("subject_is_self", Fact::Bool(f.subject_is_self)),
    ];
    bundles()?[index].decide(principal, org, &[], resource_org, &facts)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn holder(kind: &str) -> ItemCompleteFacts {
        ItemCompleteFacts {
            item_kind: kind.to_owned(),
            actor_holds_owner_line: true,
            actor_scope_covers: true,
            has_subject_user: true,
            subject_is_self: false,
        }
    }

    #[test]
    fn every_kind_compiles_strictly_and_permits_a_line_holder_in_scope() {
        for (kind, _) in ACTIONS {
            assert_eq!(
                decide(kind, "u", "o", "o", &holder(kind)),
                Ok(true),
                "{kind}"
            );
        }
    }

    #[test]
    fn nobody_completes_an_item_of_their_own_case() {
        for (kind, _) in ACTIONS {
            let own = ItemCompleteFacts {
                subject_is_self: true,
                ..holder(kind)
            };
            assert_eq!(decide(kind, "u", "o", "o", &own), Ok(false), "{kind}");
        }
        // A subject with no account is nobody's own case.
        let no_account = ItemCompleteFacts {
            has_subject_user: false,
            ..holder("PAY")
        };
        assert_eq!(decide("PAY", "u", "o", "o", &no_account), Ok(true));
    }

    #[test]
    fn the_line_the_scope_the_tenant_and_the_kind_must_all_fit() {
        let flips: [fn(&mut ItemCompleteFacts); 3] = [
            |f| f.actor_holds_owner_line = false,
            |f| f.actor_scope_covers = false,
            |f| f.item_kind = "DOC".into(),
        ];
        for flip in flips {
            let mut facts = holder("PAY");
            flip(&mut facts);
            assert_eq!(decide("PAY", "u", "o", "o", &facts), Ok(false), "{facts:?}");
        }
        assert_eq!(decide("PAY", "u", "o", "other", &holder("PAY")), Ok(false));
    }

    #[test]
    fn an_unknown_kind_or_a_missing_fact_is_refused() {
        assert!(decide("XYZ", "u", "o", "o", &holder("XYZ")).is_err());
        let bundle = &bundles().unwrap()[0];
        let partial = [("item_kind", Fact::Str("DOC".into()))];
        assert!(bundle.decide("u", "o", &[], "o", &partial).is_err());
        let mistyped = [
            ("item_kind", Fact::Str("DOC".into())),
            ("actor_holds_owner_line", Fact::Str("yes".into())),
            ("actor_scope_covers", Fact::Bool(true)),
            ("has_subject_user", Fact::Bool(true)),
            ("subject_is_self", Fact::Bool(false)),
        ];
        assert!(bundle.decide("u", "o", &[], "o", &mistyped).is_err());
    }
}
