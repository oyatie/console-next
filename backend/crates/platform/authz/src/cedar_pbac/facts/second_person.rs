//! The shared second-person fact block (decisions D0.2, #7; spec bw29 §4).
//! An action whose rule needs a second person lists these in its
//! [`ActionSchema`](super::super::action_schema::ActionSchema) facts, so every
//! lane spells them the same way. The values are computed by the use case:
//! `other_eligible_holders` by identity's fact builder, `step_up` from a
//! recorded step-up assertion, `sole_holder_mode` from the resolved
//! `authz.sole_holder.mode` setting (plan D2).

use super::super::action_schema::{FactType, RequiredFact};

const fn fact(name: &'static str, ty: FactType) -> RequiredFact {
    RequiredFact { name, ty }
}

pub const OTHER_ELIGIBLE_HOLDERS: RequiredFact = fact("other_eligible_holders", FactType::Long);
pub const STEP_UP: RequiredFact = fact("step_up", FactType::Bool);
pub const ACTOR_IS_REQUESTER: RequiredFact = fact("actor_is_requester", FactType::Bool);
pub const ACTOR_CONTRIBUTED: RequiredFact = fact("actor_contributed", FactType::Bool);
pub const ACTOR_HOLDS_PERMISSION: RequiredFact = fact("actor_holds_permission", FactType::Bool);
pub const SOLE_HOLDER_MODE: RequiredFact = fact("sole_holder_mode", FactType::String);

/// The whole block, for actions that take it unchanged.
pub const SECOND_PERSON_BLOCK: [RequiredFact; 6] = [
    OTHER_ELIGIBLE_HOLDERS,
    STEP_UP,
    ACTOR_IS_REQUESTER,
    ACTOR_CONTRIBUTED,
    ACTOR_HOLDS_PERMISSION,
    SOLE_HOLDER_MODE,
];
