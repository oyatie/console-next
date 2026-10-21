//! The 운영 시작 preview and the Rust backstop of the go-live decision.

use std::collections::BTreeMap;

use crate::preview_digest::digest;
use serde::Serialize;

use crate::{PreviewDetails, SetupFacts};

/// A record a preview line counts, so its fix opens on that record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Record {
    /// `legal_entity`, `registration` or `workplace`.
    pub kind: String,
    pub id: String,
    pub name: String,
    /// The 법인 whose record holds the fix.
    pub legal_entity_id: String,
}

/// The records behind each counted line, by item code, in a stable order.
/// The adapter derives those lines' counts from these lists, so a count
/// always equals its records (company-49).
pub type Records = BTreeMap<String, Vec<Record>>;

/// One preview line: a stable code (the client renders copy from it), an
/// optional count, the fix the client links to and the records it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub code: &'static str,
    pub count: Option<i64>,
    pub remedy: Option<&'static str>,
    pub support_ref: Option<&'static str>,
    pub records: Vec<Record>,
}

fn item(code: &'static str, count: i64, remedy: &'static str) -> Item {
    Item {
        code,
        count: Some(count),
        remedy: Some(remedy),
        support_ref: None,
        records: Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub phase: &'static str,
    pub blockers: Vec<Item>,
    pub warnings: Vec<Item>,
    /// What changes at 운영 시작 (design §5.2 right-hand column), as codes.
    pub becomes_governed: Vec<&'static str>,
    pub facts: SetupFacts,
    /// SHA-256 over everything above; 운영 시작 must send it back unchanged.
    pub digest: String,
    pub line_digests: BTreeMap<String, String>,
    #[serde(flatten)]
    pub details: PreviewDetails,
}

impl Preview {
    /// Bind the named records and scopes to the same digest as the readiness facts.
    #[must_use]
    pub fn with_details(mut self, details: PreviewDetails) -> Self {
        self.details = details;
        self.line_digests = crate::preview_digest::lines(&self);
        self.digest = digest(&self);
        self
    }
}

/// Build the preview. Blockers are exactly what the go-live decision needs;
/// everything else that deserves attention is a warning. Only lines about a
/// capability that exists are listed (company-49).
#[must_use]
pub fn preview(f: &SetupFacts, records: &Records) -> Preview {
    let mut blockers = Vec::new();
    if !f.phase_is_setup {
        blockers.push(item("already_operating", 0, "none"));
    }
    if !f.terms_accepted {
        blockers.push(item("terms_not_accepted", 0, "accept_terms"));
    }
    if f.access_admin_holders == 0 {
        blockers.push(item("no_access_admin", 0, "grant_access_admin"));
    }
    if f.entities == 0 {
        blockers.push(item("no_legal_entity", 0, "create_legal_entity"));
    }
    if f.entities_needing_confirmation > 0 {
        blockers.push(item(
            "entity_needs_confirmation",
            f.entities_needing_confirmation,
            "confirm_legal_entity",
        ));
    }
    if f.registrations_needing_confirmation > 0 {
        blockers.push(item(
            "registration_needs_confirmation",
            f.registrations_needing_confirmation,
            "confirm_registration",
        ));
    }
    if f.entities > 0 && f.workplaces == 0 {
        blockers.push(item("no_workplace", 0, "create_workplace"));
    }
    if f.entities_without_primary_workplace > 0 {
        blockers.push(item(
            "no_primary_workplace",
            f.entities_without_primary_workplace,
            "set_primary_workplace",
        ));
    }
    if f.workplaces_incomplete > 0 {
        blockers.push(item(
            "workplace_incomplete",
            f.workplaces_incomplete,
            "complete_workplace",
        ));
    }
    if f.staffed_workplaces_without_registration > 0 {
        let mut missing = item(
            "staffed_workplace_without_registration",
            f.staffed_workplaces_without_registration,
            "attach_registration",
        );
        missing.support_ref = Some("workplace_registration_answer");
        blockers.push(missing);
    }
    if f.org_units == 0 {
        blockers.push(item("no_department", 0, "add_department"));
    }
    if !f.org_change_route_resolvable() {
        blockers.push(item("no_org_change_approver", 0, "invite_executive"));
    }

    let mut warnings = Vec::new();
    let mut warn = |cond: bool, code, count, remedy| {
        if cond {
            warnings.push(item(code, count, remedy));
        }
    };
    // decisions #26: a sole holder matters only where a second person is
    // asked for; under approval.policy.org_structure = none nobody is.
    warn(
        f.sole_holder_ack_required(),
        "sole_holder",
        0,
        "invite_executive",
    );
    // Under approval.policy.org_structure = route an org change after
    // go-live needs a second decider; under none (decisions #26) it does not.
    warn(
        f.org_change_routed && f.other_eligible_holders == 0,
        "org_change_needs_second_person_after_go_live",
        0,
        "invite_executive",
    );
    // governance-20: with one passkey a lost device ends the account. Never
    // a blocker (an admin with one device must not dead-end).
    warn(
        f.own_passkeys < 2,
        "single_passkey",
        f.own_passkeys,
        "add_passkey",
    );
    warn(
        f.security_contact_store_available && !f.security_contact_recorded,
        "security_contact_missing",
        0,
        "record_security_contact",
    );
    warn(
        f.registrations_unverified > 0,
        "registration_unverified",
        f.registrations_unverified,
        "verify_registration",
    );
    warn(
        f.empty_workplaces_without_registration > 0,
        "workplace_without_registration",
        f.empty_workplaces_without_registration,
        "attach_registration",
    );
    warn(
        f.unmapped_assignments > 0,
        "company_names_to_map",
        f.unmapped_assignments,
        "place_people",
    );
    warn(
        f.insurance_not_established_with_people > 0,
        "insurance_not_established_with_people",
        f.insurance_not_established_with_people,
        "update_insurance",
    );
    warn(
        f.insurance_numbers_pending > 0,
        "insurance_numbers_pending",
        f.insurance_numbers_pending,
        "enter_insurance_numbers",
    );
    warn(
        f.org_changes_in_approval > 0,
        "org_changes_waiting_for_approval",
        f.org_changes_in_approval,
        "review_org_changes",
    );
    warn(f.employees == 0, "no_employees_yet", 0, "register_employee");
    warn(
        f.unplaced_people > 0,
        "unplaced_people",
        f.unplaced_people,
        "place_people",
    );
    warn(
        f.entity_unknown_people > 0,
        "entity_unknown_people",
        f.entity_unknown_people,
        "place_people",
    );

    let mut becomes_governed = vec![
        "org_structure_changes_need_approval",
        "entity_identifier_corrections_locked",
        "setup_voids_unavailable",
        "setup_undo_becomes_correction",
        "exits_leave_payroll_available",
    ];
    if !f.org_change_routed {
        // decisions #26: org changes go through proposals, applied directly.
        becomes_governed[0] = "org_structure_changes_through_proposals";
    }
    for line in blockers.iter_mut().chain(warnings.iter_mut()) {
        line.records = records.get(line.code).cloned().unwrap_or_default();
    }
    let mut out = Preview {
        phase: f.phase().as_str(),
        blockers,
        warnings,
        becomes_governed,
        facts: *f,
        digest: String::new(),
        line_digests: BTreeMap::new(),
        details: PreviewDetails::default(),
    };
    out.line_digests = crate::preview_digest::lines(&out);
    out.digest = digest(&out);
    out
}

/// The Rust half of the go-live decision (Cedar is the other; both must allow).
/// Returns the failing fact names, empty when allowed.
#[must_use]
pub fn backstop(
    f: &SetupFacts,
    super_admin: bool,
    step_up: bool,
    sole_holder_acknowledged: bool,
    digest_matches: bool,
) -> Vec<&'static str> {
    let checks = [
        (super_admin, "super_admin"),
        (step_up, "step_up"),
        (f.phase_is_setup, "phase"),
        (f.entities_ready(), "entities_ready"),
        (f.primary_workplaces_ready(), "primary_workplaces_ready"),
        (f.org_units > 0, "org_units"),
        (
            f.org_change_route_resolvable(),
            "org_change_route_resolvable",
        ),
        (
            !f.sole_holder_ack_required() || sole_holder_acknowledged,
            "sole_holder_acknowledged",
        ),
        (
            f.security_contact_recorded || !f.security_contact_store_available,
            "security_contact_recorded",
        ),
        (f.terms_accepted, "terms_accepted"),
        (f.access_admin_holders > 0, "access_admin_holders"),
        (digest_matches, "preview_digest_matches"),
    ];
    checks
        .into_iter()
        .filter(|(ok, _)| !ok)
        .map(|(_, name)| name)
        .collect()
}

#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;
