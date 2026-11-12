//! The scope-grant fact block (entity design ED §3.11; decisions #15).
//! Authority over a legal entity or workplace comes from scope grants, never from the
//! holder's own employer, so a grant on another legal entity is an ordinary grant with
//! the same rule (#15.3):
//! `context.scope_tenant || context.scope_entities.containsAny(context.resource_entities)`.
//! `scope_entities` holds the legal entity and workplace ids of the holder's grants;
//! `resource_entities` holds the resource's own legal entity id and, when it has one,
//! its workplace id. A tenant-level act (a new legal entity) has none, so only a tenant
//! grant reaches it. The same rule is the Rust `WHERE` backstop on lists.

use std::collections::BTreeSet;

use crate::access::NodeKind;
use uuid::Uuid;

use super::super::action_schema::{FactType, RequiredFact};
use super::{FactValue, Facts};

pub const SCOPE_TENANT: RequiredFact = RequiredFact {
    name: "scope_tenant",
    ty: FactType::Bool,
};
pub const SCOPE_ENTITIES: RequiredFact = RequiredFact {
    name: "scope_entities",
    ty: FactType::StringSet,
};
pub const RESOURCE_ENTITIES: RequiredFact = RequiredFact {
    name: "resource_entities",
    ty: FactType::StringSet,
};

/// The block, for actions that take it unchanged.
pub const SCOPE_BLOCK: [RequiredFact; 3] = [SCOPE_TENANT, SCOPE_ENTITIES, RESOURCE_ENTITIES];

/// Project loaded grants to scope facts: `None` means the whole tenant.
/// Department grants never widen to their employer or workplace.
#[must_use]
pub fn granted_scope(nodes: impl IntoIterator<Item = (NodeKind, Uuid)>) -> Option<Vec<Uuid>> {
    let mut ids = Vec::new();
    for (kind, id) in nodes {
        match kind {
            NodeKind::Tenant => return None,
            NodeKind::LegalEntity | NodeKind::Workplace => ids.push(id),
            NodeKind::Department => {}
        }
    }
    Some(ids)
}

fn ids(list: &[Uuid]) -> FactValue {
    FactValue::StringSet(
        list.iter()
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>(),
    )
}

/// The scope facts of one decision: the holder's reach (`None` = the whole
/// tenant, else the granted legal entity/workplace ids) and the resource's ids.
#[must_use]
pub fn scope_facts(facts: Facts, granted: Option<&[Uuid]>, resource: &[Uuid]) -> Facts {
    facts
        .bool(SCOPE_TENANT.name, granted.is_none())
        .with(SCOPE_ENTITIES.name, ids(granted.unwrap_or_default()))
        .with(RESOURCE_ENTITIES.name, ids(resource))
}
