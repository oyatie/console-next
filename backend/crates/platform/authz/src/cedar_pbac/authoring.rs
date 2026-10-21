//! Cedar policy authoring + point-decision evaluation (Policy Studio spine).
//!
//! This module is DEPENDENCY-LIGHT on purpose: it holds only pure domain logic
//! (no DB, no request-context) so `crates/platform/authz` never needs to depend
//! on `request-context` — which itself depends on `authz` — and the crate DAG
//! stays acyclic. Persistence + REST live in the thin `authz-rest` crate.
//!
//! Three responsibilities, all fail-closed:
//!  * **No-code authoring.** [`NoCodeBlocks`] → [`normalize`] (canonical row) →
//!    [`generate_cedar_text`] (real Cedar `permit`/`forbid`), then
//!    [`validate_blocks`] strict-validates the generated policy against
//!    [`AUTHORING_SCHEMA`] by reusing the already-audited
//!    [`engine::compile_bundle_from_sources`]. A draft that does not typecheck is
//!    marked `Invalid` and can never be submitted.
//!  * **Draft lifecycle.** [`submit_draft`] (validation must be `Valid`) and
//!    [`review_draft`] (four-eyes: reviewer ≠ author) move a draft
//!    `draft → review_pending → approved_for_promotion | rejected`. Nothing here
//!    can produce a `shadow`/`enforced` row — promotion is a separate gated lane.
//!  * **Point decision.** [`simulate`] is the single evaluator behind both the
//!    `/policy/simulate` (what-if) and `/policy/authorize` (live) surfaces:
//!    deny-by-omission default, `forbid` always wins, unknown action ⇒ deny, and
//!    the whole Cedar call is `catch_unwind`-isolated exactly like [`engine`].
//!
//! [`engine`]: super::engine

use super::engine;

mod blocks;
mod entities;
mod render;
mod review;
mod schema;
mod simulate;

pub use blocks::*;
use entities::*;
pub use render::*;
pub use review::*;
pub use schema::*;
pub use simulate::*;

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use console_kernel_core::{OrgId, UserId};

    fn owner_view_permit(resource_type: &str) -> NoCodeBlocks {
        NoCodeBlocks {
            effect: Effect::Permit,
            action: "view".to_owned(),
            resource_type: resource_type.to_owned(),
            conditions: vec![Condition {
                attr: "owner".to_owned(),
                op: ConditionOp::Eq,
                value: ConditionValue::SubjectAttr("user_id".to_owned()),
            }],
        }
    }

    fn subject(user_id: &str) -> SimSubject {
        SimSubject {
            org: OrgId::one(),
            user_id: user_id.to_owned(),
            roles: vec![],
            clearance_keys: vec![],
        }
    }

    fn row(owner: &str) -> SimResource {
        SimResource {
            org: OrgId::one(),
            resource_type: "work_order".to_owned(),
            resource_id: Some("wo-1".to_owned()),
            owner: Some(owner.to_owned()),
            branch: None,
            legal_hold: None,
        }
    }

    fn flagged_forbid(resource_type: &str) -> NoCodeBlocks {
        NoCodeBlocks {
            effect: Effect::Forbid,
            action: "view".to_owned(),
            resource_type: resource_type.to_owned(),
            conditions: vec![Condition {
                attr: "flagged".to_owned(),
                op: ConditionOp::Eq,
                value: ConditionValue::Bool(true),
            }],
        }
    }

    fn flagged_declared() -> Vec<DeclaredAttr> {
        vec![DeclaredAttr {
            key: "flagged".to_owned(),
            boolean: true,
        }]
    }

    #[test]
    fn declared_object_property_authors_and_strict_validates() {
        let v = validate_blocks_with(
            OrgId::one(),
            &flagged_forbid("policycase"),
            &flagged_declared(),
        );
        assert!(
            v.valid,
            "a policy over a declared object property must author: {:?}",
            v.errors
        );
        // Optional in the spliced schema, so an instance without the attribute
        // fails the `when` closed rather than erroring.
        assert!(
            v.generated_policy_text
                .contains("resource has flagged && resource.flagged == true"),
            "declared properties must carry a has-guard: {}",
            v.generated_policy_text
        );
    }

    #[test]
    fn undeclared_object_property_is_still_rejected() {
        let v = validate_blocks_with(OrgId::one(), &flagged_forbid("policycase"), &[]);
        assert!(!v.valid, "an undeclared property must not author");
        assert!(
            v.errors.iter().any(|e| e.contains("flagged")),
            "error must name the offending attribute: {:?}",
            v.errors
        );
    }

    #[test]
    fn declared_property_type_mismatch_fails_cedar_validation() {
        // Declared Bool, compared against a string literal: the spliced schema
        // makes this decidable, so strict validation rejects it.
        let mut blocks = flagged_forbid("policycase");
        blocks.conditions[0].value = ConditionValue::Literal("yes".to_owned());
        let v = validate_blocks_with(OrgId::one(), &blocks, &flagged_declared());
        assert!(
            !v.valid,
            "Bool property vs string literal must not validate"
        );
    }

    #[test]
    fn schema_splice_anchor_is_exact() {
        assert_eq!(
            AUTHORING_SCHEMA.matches(SCHEMA_SPLICE_ANCHOR).count(),
            1,
            "editing AUTHORING_SCHEMA must not silently disable object-scoped policies"
        );
        assert_eq!(
            object_authoring_schema(&[]),
            AUTHORING_SCHEMA,
            "no declared properties must leave the schema byte-identical"
        );
        assert!(
            object_authoring_schema(&flagged_declared()).contains("\"flagged\"?: Bool"),
            "declared properties must reach the Resource entity"
        );
    }

    #[test]
    fn owner_permit_generates_and_validates() {
        let v = validate_blocks(OrgId::one(), &owner_view_permit("work_order"));
        assert!(
            v.valid,
            "owner-view permit must strict-validate: {:?}",
            v.errors
        );
        assert!(v.generated_policy_text.contains("permit("));
        assert!(
            v.generated_policy_text
                .contains("resource.owner == principal.user_id")
        );
    }

    #[test]
    fn unknown_action_is_invalid() {
        let mut blocks = owner_view_permit("work_order");
        blocks.action = "delete_everything".to_owned();
        let v = validate_blocks(OrgId::one(), &blocks);
        assert!(
            !v.valid,
            "an undeclared action must be rejected fail-closed"
        );
    }

    #[test]
    fn non_whitelisted_attr_is_invalid() {
        let mut blocks = owner_view_permit("work_order");
        blocks.conditions[0].attr = "secret_backdoor".to_owned();
        let v = validate_blocks(OrgId::one(), &blocks);
        assert!(!v.valid, "a non-whitelisted attribute must be rejected");
    }

    #[test]
    fn authorize_denies_by_omission_with_no_policies() {
        let out = simulate(
            &[],
            &SimRequest {
                subject: subject("alice"),
                action: "view".to_owned(),
                resource: row("alice"),
                purpose: None,
                field: None,
            },
        );
        assert_eq!(out.effect, SimEffect::Deny);
        assert!(out.determining_policies.is_empty());
    }

    #[test]
    fn object_policy_hides_cross_principal_row() {
        let text = generate_cedar_text(&owner_view_permit("work_order"));
        let policies = [AuthoredPolicy::new("owner_view", text)];
        // Alice owns the row ⇒ visible.
        assert!(object_row_visible(
            &policies,
            subject("alice"),
            row("alice")
        ));
        // Bob does not own it ⇒ hidden (deny-by-omission).
        assert!(!object_row_visible(&policies, subject("bob"), row("alice")));
    }

    #[test]
    fn forbid_always_wins_over_permit() {
        let permit = generate_cedar_text(&owner_view_permit("work_order"));
        let forbid = generate_cedar_text(&NoCodeBlocks {
            effect: Effect::Forbid,
            action: "view".to_owned(),
            resource_type: "work_order".to_owned(),
            conditions: vec![Condition {
                attr: "legal_hold".to_owned(),
                op: ConditionOp::Eq,
                value: ConditionValue::Bool(true),
            }],
        });
        let policies = [
            AuthoredPolicy::new("owner_view", permit),
            AuthoredPolicy::new("legal_hold_forbid", forbid),
        ];
        // Alice owns the row, but it is under legal hold: forbid wins ⇒ hidden.
        let mut held = row("alice");
        held.legal_hold = Some(true);
        let out = simulate(
            &policies,
            &SimRequest {
                subject: subject("alice"),
                action: "view".to_owned(),
                resource: held,
                purpose: None,
                field: None,
            },
        );
        assert_eq!(out.effect, SimEffect::Deny, "forbid must win: {out:?}");
        // Same subject/row without the hold is visible again.
        assert!(object_row_visible(
            &policies,
            subject("alice"),
            row("alice")
        ));
    }

    #[test]
    fn simulate_reports_determining_policy_and_no_errors() {
        let text = generate_cedar_text(&owner_view_permit("work_order"));
        let policies = [AuthoredPolicy::new("owner_view", text)];
        let out = simulate(
            &policies,
            &SimRequest {
                subject: subject("alice"),
                action: "view".to_owned(),
                resource: row("alice"),
                purpose: None,
                field: None,
            },
        );
        assert_eq!(out.effect, SimEffect::Allow);
        assert_eq!(out.determining_policies, vec!["owner_view".to_owned()]);
        assert!(out.errors.is_empty(), "clean allow has no diagnostics");
    }

    /// Unguarded read of the optional `legal_hold`: errors when the row omits it.
    const ERRORING_FORBID: &str =
        "forbid(principal, action, resource) when { resource.legal_hold == true };";
    const ERRORING_PERMIT: &str =
        "permit(principal, action, resource) when { resource.legal_hold == false };";

    fn view(owner: &str) -> SimRequest {
        SimRequest {
            subject: subject("alice"),
            action: "view".to_owned(),
            resource: row(owner),
            purpose: None,
            field: None,
        }
    }

    // SEC-S1: Cedar skips an erroring policy, so an erroring forbid used to let
    // the matching permit win.
    #[test]
    fn erroring_forbid_with_matching_permit_fails_closed() {
        let permit = generate_cedar_text(&owner_view_permit("work_order"));
        let policies = [
            AuthoredPolicy::new("owner_view", permit),
            // Lets property_field_visible reach the forbid on `read_field` too.
            AuthoredPolicy::new("any", "permit(principal, action, resource);"),
            AuthoredPolicy::new("bad_forbid", ERRORING_FORBID),
        ];
        let out = simulate(&policies, &view("alice"));
        assert_eq!(out.effect, SimEffect::Deny, "erroring forbid: {out:?}");
        assert!(!out.errors.is_empty(), "errors must be carried: {out:?}");
        assert!(out.reason.contains("fail closed"), "{out:?}");
        assert!(!object_row_visible(
            &policies,
            subject("alice"),
            row("alice")
        ));
        assert!(!property_field_visible(
            &policies,
            subject("alice"),
            row("alice"),
            "amount"
        ));
    }

    #[test]
    fn erroring_permit_without_forbid_fails_closed() {
        let out = simulate(
            &[AuthoredPolicy::new("bad_permit", ERRORING_PERMIT)],
            &view("alice"),
        );
        assert_eq!(out.effect, SimEffect::Deny);
        assert!(!out.errors.is_empty(), "errors must be carried: {out:?}");
        assert!(out.reason.contains("fail closed"), "{out:?}");
    }

    #[test]
    fn submit_requires_valid_and_review_blocks_self() {
        assert!(submit_draft(ReviewStatus::Draft, false).is_err());
        assert_eq!(
            submit_draft(ReviewStatus::Draft, true).unwrap(),
            ReviewStatus::ReviewPending
        );
        let author = UserId::new();
        let reviewer = UserId::new();
        assert!(
            review_draft(
                ReviewStatus::ReviewPending,
                ReviewDecision::Approve,
                author,
                author
            )
            .is_err(),
            "self-review must be blocked"
        );
        assert_eq!(
            review_draft(
                ReviewStatus::ReviewPending,
                ReviewDecision::Approve,
                author,
                reviewer
            )
            .unwrap(),
            ReviewStatus::ApprovedForPromotion
        );
    }

    /// Defect (c): an object type may be keyed `hr.employee` (`0152:20`), and the
    /// runtime matches an attached policy by `block.resource_type == stable_key`.
    /// A dotted key must therefore validate, while every shape the object-type
    /// CHECK refuses must still be refused here.
    #[test]
    fn resource_type_accepts_dotted_stable_keys_and_still_refuses_everything_else() {
        for accepted in ["work_order", "hr.employee", "a.b.c", "a1_2.b3"] {
            let validation = validate_blocks(OrgId::one(), &owner_view_permit(accepted));
            assert!(
                validation.valid,
                "{accepted:?} must be policyable: {:?}",
                validation.errors
            );
        }
        for refused in [
            "", ".a", "a.", "a..b", "1abc", "_x", "A", "a b", "a\"b", "a-b", "a.B", "a.1b",
        ] {
            let validation = validate_blocks(OrgId::one(), &owner_view_permit(refused));
            assert!(!validation.valid, "{refused:?} must be refused");
            assert!(
                validation
                    .errors
                    .iter()
                    .any(|error| error.contains("stable key")),
                "{refused:?} must be refused BY THE KEY SHAPE, not incidentally: {:?}",
                validation.errors
            );
        }
    }
}
