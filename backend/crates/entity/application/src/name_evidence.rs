//! Typed identity problems of a legal entity, computed on every read from its
//! one stored name.
use crate::LegalEntityView;
use console_entity_domain::{
    Warning,
    codes::BizKind,
    names::{PERSON_CODES, is_person},
    registration_classification::classification,
    registration_number::validate_classification,
};

#[must_use]
pub fn identity_problems(e: &LegalEntityView) -> Vec<Warning> {
    let primary = e
        .workplaces
        .iter()
        .find(|w| Some(w.id) == e.primary_workplace_id)
        .and_then(|w| w.registration_id);
    let reg = primary.and_then(|id| e.registrations.iter().find(|r| r.id == id));
    let reg = reg.or_else(|| (e.registrations.len() == 1).then(|| &e.registrations[0]));
    // Existing data is held to the entry rule: a branch number (or one of
    // another kind) as the representative registration number needs its recorded reason.
    let mut problems: Vec<Warning> = reg
        .and_then(|r| r.brn.as_ref().map(|b| (b, r.current.as_ref())))
        .filter(|(brn, facts)| {
            let rule = classification(&brn.value);
            validate_classification(
                e.biz_kind,
                true,
                facts.and_then(|f| f.classification_reason.as_deref()),
                rule.map(|r| (r.biz_kinds.as_slice(), r.head_office)),
            )
            .is_err()
        })
        .map(|_| Warning {
            field: "brn".into(),
            code: "primary_registration_classification",
        })
        .into_iter()
        .collect();
    let confirmed =
        reg.is_some_and(|r| !r.needs_confirmation && r.closed_on.is_none() && r.current.is_some());
    if !confirmed {
        problems.insert(
            0,
            Warning {
                field: "name".into(),
                code: "legal_name_unconfirmed",
            },
        );
    }
    let Some(c) = e.current.as_ref() else {
        return problems;
    };
    // Commercial Registration Rules §2: a legal entity's registered trade name
    // is written in Hangul (Roman letters only in parentheses after it), so a
    // legal entity name without Hangul was mis-entered.
    if e.biz_kind == Some(BizKind::Corporation)
        && !c.name.chars().any(|c| ('가'..='힣').contains(&c))
    {
        problems.push(Warning {
            field: "name".into(),
            code: "legal_name_not_hangul",
        });
    }
    // Saved before the guard existed: person data in a name field goes to "needs checking".
    let reps = c.representatives.as_deref().unwrap_or_default();
    let names = [
        Some(c.name.as_str()),
        c.display_name.as_deref(),
        c.english_name.as_deref(),
    ];
    for ((field, code), name) in PERSON_CODES.into_iter().zip(names) {
        if name.is_some_and(|n| is_person(n, reps)) {
            problems.push(Warning {
                field: field.into(),
                code,
            });
        }
    }
    if !e.name_reviews.is_empty() {
        problems.push(Warning {
            field: "name".into(),
            code: "legal_name_review",
        });
    }
    problems
}
