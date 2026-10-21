//! The pilot access model (decision #26; access-model AX-2, AX-3 and the
//! grant loader): tenant roles are bundles of domain × level lines, grants are
//! account × role × scope node × dates, and Cedar decides. No role names, no
//! presets, no seeds.

pub mod catalog;
pub mod cedar;
pub mod exit;
pub mod load;
pub mod model;
pub mod project;
pub mod tags;

#[cfg(test)]
mod project_tests;
#[cfg(test)]
mod tests;

pub use catalog::{CatalogError, Domain, Level, action_group, normalize_levels};
pub use cedar::{AccessEngineError, AccessSlice};
pub use exit::{CredentialSweep, ExitRevocation, revoke_privileged_access, sweep_credentials_tx};
pub use load::{dept_path, load_access_subject, load_tenant_phase, scope_path};
pub use model::{
    AccessSubject, Enforcement, GrantState, HeldGrant, NodeKind, NodePath, NodeRef, RoleLine,
    ScopeGrant, union_branches,
};
pub use project::{Projection, project};
pub use tags::{tag, tagged};
