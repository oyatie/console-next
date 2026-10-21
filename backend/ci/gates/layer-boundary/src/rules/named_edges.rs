//! The named layer-rule exceptions, moved verbatim from `rules.rs` so the
//! registry can grow without pushing that file past the size ceiling.

/// Workspace edges the layer table forbids but that are named and reasoned.
/// The expected use is adapter → adapter where the callee OWNS the tables and
/// exposes an in-transaction API (`*_in_tx(&mut Transaction, …)`, ADR-004): the
/// owner stays the only writer (writer-ownership gate unchanged). No wildcards:
/// a wildcard can never go stale, so it could never shrink.
///
/// (from, to, reason). Add each owner entry in the commit that adds the Cargo
/// edge (Tier 1 step 3 adds the three hr edges; the orgchange split adds
/// `console-orgchange-adapter-postgres` → canonical and deletes the `#[path]`
/// exception below).
pub const NAMED_EDGES: &[(&str, &str, &str)] = &[
    // Pre-existing since fork 86fa08c (crates/platform/realtime/Cargo.toml):
    (
        "console-platform-realtime",
        "console-messenger-adapter-postgres",
        "pre-existing: realtime fan-out reads messenger stores; move behind a port (Tier 3)",
    ),
    (
        "console-platform-realtime",
        "console-notifications-adapter-postgres",
        "pre-existing: realtime fan-out reads notification stores; move behind a port (Tier 3)",
    ),
    (
        "console-hr-adapter-postgres",
        "console-ontology-canonical-adapter-postgres",
        "ADR-004: employment/person write_in_tx",
    ),
    (
        "console-hr-adapter-postgres",
        "console-leave-adapter-postgres",
        "ADR-004: employee create via leave definer pool until ownership is consolidated",
    ),
    // ("console-hr-adapter-postgres", "console-recruiting-adapter-postgres", "ADR-004: hire handshake marks the candidate hired in-tx"),
    (
        "console-hr-adapter-postgres",
        "console-governance-adapter-postgres",
        "ADR-004 (BW-12, BW-19): a renewal past the fixed-term limit consumes its BW-06 exception in-tx; a registration records and consumes DUPLICATE_NAME_CONFIRMED in-tx",
    ),
    (
        "console-hr-adapter-postgres",
        "console-entity-adapter-postgres",
        "ADR-004 (E-S2, E-S3b, MR-22, MR-7): exits, 전근, 전적, registration and import write the employment assignment in-tx",
    ),
    (
        "console-hr-adapter-postgres",
        "console-settings-adapter-postgres",
        "ADR-004/ADR-006 (BW-19): resolve_in_tx and validate_reason_in_tx inside the registration tx",
    ),
    (
        "console-identity-adapter-postgres",
        "console-settings-adapter-postgres",
        "ADR-006 (AUTH-ID, decisions #33): validate_reason_in_tx inside the sign-in ID change tx",
    ),
    (
        "console-orgchange-adapter-postgres",
        "console-settings-adapter-postgres",
        "ADR-006 (D26): approval.policy.org_structure resolved inside the submit tx",
    ),
    (
        "console-onboarding-adapter-postgres",
        "console-settings-adapter-postgres",
        "ADR-006 (D26): approval.policy.org_structure read into the setup facts",
    ),
];
