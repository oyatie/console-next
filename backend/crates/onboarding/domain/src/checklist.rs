//! The setup rail (design §6.2; challenge (d) A11): steps in three groups —
//! 조직 구조 (법인·사업장), 운영 방식 (조직·결재·두 번째 패스키; 보안 연락처
//! once its store exists), 사람 (직원·운영 시작). There is no 결재 step under
//! `approval.policy.org_structure = none` (decisions #26). Each step has a state, one primary action and, when it
//! cannot proceed, the prerequisite that opens in place (never a greyed-out
//! step without its fix).

use serde::Serialize;

use crate::{SetupFacts, preview};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Todo,
    Done,
    /// Done, with something to look at (count + remedy).
    Attention,
    /// Cannot proceed yet; `remedy` opens the missing prerequisite in place.
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub key: &'static str,
    pub group: &'static str,
    pub state: StepState,
    /// The one primary action for the step.
    pub action: &'static str,
    /// The fix or follow-up the client links to, when there is one.
    pub remedy: Option<&'static str>,
    pub count: Option<i64>,
    /// The step may be completed by an explicit 「나중에」 / 「없이 진행」 choice.
    pub skippable: bool,
    pub counts: Counts,
    pub paths: Vec<&'static str>,
    pub can_act: bool,
    pub needs: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Counts {
    pub entities: i64,
    pub workplaces: i64,
    pub units: i64,
    pub people: i64,
    pub unplaced: i64,
    pub entity_unknown: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub people: i64,
    pub placed: i64,
    pub unplaced: i64,
    pub entity_unknown: i64,
    pub progress: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Checklist {
    pub phase: &'static str,
    pub go_live_at: Option<String>,
    pub steps: Vec<Step>,
    pub done: usize,
    pub total: usize,
    pub summary: Summary,
}

fn step(key: &'static str, group: &'static str, state: StepState, action: &'static str) -> Step {
    Step {
        key,
        group,
        state,
        action,
        remedy: None,
        count: None,
        skippable: false,
        counts: Counts::default(),
        paths: if matches!(key, "entity" | "workplace" | "org" | "employees") {
            vec!["one", "paste", "import"]
        } else {
            vec!["one"]
        },
        can_act: false,
        needs: match key {
            "entity" | "workplace" | "org" => "org::edit",
            "employees" => "hr_basic::edit",
            "roles" => "access::edit",
            "approval" => "settings::edit",
            "passkey" => "own_account",
            _ => "tenant_ops",
        },
    }
}

#[must_use]
pub fn checklist(f: &SetupFacts) -> Checklist {
    use StepState::{Attention, Blocked, Done, Todo};
    let mut steps = Vec::with_capacity(7);

    let mut entity = step("entity", "company", Todo, "register_legal_entity");
    if f.entities > 0 {
        let pending = f.entities_needing_confirmation + f.registrations_needing_confirmation;
        entity.state = if pending > 0 { Attention } else { Done };
        if pending > 0 {
            entity.remedy = Some("confirm_legal_entity");
            entity.count = Some(pending);
        } else if f.registrations_unverified > 0 {
            entity.state = Attention;
            entity.remedy = Some("verify_registration");
            entity.count = Some(f.registrations_unverified);
        }
    }
    steps.push(entity);

    let mut workplace = step("workplace", "company", Todo, "create_primary_workplace");
    if f.entities == 0 {
        workplace.state = Blocked;
        workplace.remedy = Some("create_legal_entity");
    } else if f.workplaces > 0 {
        let gaps = f.entities_without_primary_workplace
            + f.workplaces_incomplete
            + f.staffed_workplaces_without_registration;
        workplace.state = if gaps > 0 { Attention } else { Done };
        if gaps > 0 {
            workplace.remedy = Some("complete_workplace");
            workplace.count = Some(gaps);
        } else if f.insurance_numbers_pending > 0 {
            workplace.state = Attention;
            workplace.remedy = Some("enter_insurance_numbers");
            workplace.count = Some(f.insurance_numbers_pending);
        }
    }
    steps.push(workplace);

    let mut org = step("org", "operations", Todo, "add_department");
    org.skippable = false;
    if f.workplaces == 0 {
        org.state = Blocked;
        org.remedy = Some("create_workplace");
    } else if f.org_units > 0 {
        org.state = Done;
        org.count = Some(f.org_units);
    }
    steps.push(org);

    // decisions #26: the 결재선 step exists only when org changes route.
    if f.org_change_routed {
        let mut approval = step("approval", "operations", Done, "confirm_approver");
        if !f.org_change_route_resolvable() {
            approval.state = Blocked;
            approval.remedy = Some("invite_executive");
        } else if f.other_eligible_holders == 0 {
            approval.state = Attention;
            approval.remedy = Some("invite_executive");
        }
        steps.push(approval);
    }

    // The #7 contact store: listed only once it exists (company-49: no step
    // for a capability that is not offered).
    if f.security_contact_store_available {
        let mut people = step("people", "operations", Todo, "record_security_contact");
        if f.security_contact_recorded {
            people.state = Done;
        }
        steps.push(people);
    }

    // governance-20 / people-self-31: a second passkey on another device, so a
    // lost device does not end the account. Counted, never blocking.
    let mut passkey = step("passkey", "operations", Todo, "add_passkey");
    passkey.count = Some(f.own_passkeys);
    if f.own_passkeys >= 2 {
        passkey.state = Done;
    }
    steps.push(passkey);

    let mut employees = step("employees", "people", Todo, "register_employee");
    employees.skippable = true;
    if f.workplaces == 0 {
        employees.state = Blocked;
        employees.remedy = Some("create_workplace");
    } else if f.employees > 0 || f.employees_step_deferred {
        employees.state =
            if f.unmapped_assignments > 0 || f.unplaced_people > 0 || f.entity_unknown_people > 0 {
                Attention
            } else {
                Done
            };
        employees.count = Some(f.employees);
        if f.unmapped_assignments > 0 || f.unplaced_people > 0 || f.entity_unknown_people > 0 {
            employees.remedy = Some("place_people");
        }
    }
    steps.push(employees);

    let mut roles = step("roles", "operations", Todo, "add_role");
    roles.skippable = !f.roles_step_skipped;
    roles.count = Some(f.tenant_roles);
    if f.non_ops_grants > 0 || f.roles_step_skipped {
        roles.state = Done;
        if f.roles_step_skipped && f.non_ops_grants == 0 {
            roles.remedy = Some("roles_skipped");
        }
    }
    steps.push(roles);

    let p = preview(f, &crate::Records::new());
    let mut golive = step("golive", "people", Todo, "open_go_live_preview");
    if !f.phase_is_setup {
        golive.state = Done;
    } else if !p.blockers.is_empty() {
        golive.state = Blocked;
        golive.remedy = p.blockers.first().and_then(|b| b.remedy);
        golive.count = Some(i64::try_from(p.blockers.len()).unwrap_or(i64::MAX));
    }
    steps.push(golive);

    let done = steps
        .iter()
        .filter(|s| matches!(s.state, Done | Attention))
        .count();
    let total = steps.len();
    let counts = Counts {
        entities: f.entities,
        workplaces: f.workplaces,
        units: f.org_units,
        people: f.employees,
        unplaced: f.unplaced_people,
        entity_unknown: f.entity_unknown_people,
    };
    for s in &mut steps {
        s.counts = counts;
    }
    Checklist {
        phase: f.phase().as_str(),
        go_live_at: None,
        steps,
        done,
        total,
        summary: Summary {
            people: f.employees,
            placed: (f.employees - f.unplaced_people).max(0),
            unplaced: f.unplaced_people,
            entity_unknown: f.entity_unknown_people,
            progress: done * 100 / total,
        },
    }
}

#[cfg(test)]
#[path = "checklist_tests.rs"]
mod tests;
