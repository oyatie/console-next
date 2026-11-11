//! What a definition may hold: its label, its options, and how a change to
//! the options keeps every option that already exists.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::HrError;
use crate::lifecycle::title_reason::coded;

const LABEL_MAX: usize = 60;
const CHOICE_LABEL_MAX: usize = 40;
const CHOICE_MAX: usize = 50;

/// One option of a CHOICE field. Values refer to the id, so a relabel never
/// changes what was chosen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosterFieldChoice {
    pub id: Uuid,
    pub label: String,
}

/// An option as sent: an existing option names its id, a new one has none.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RosterFieldChoiceInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    pub label: String,
}

fn invalid(field: &'static str, code: &'static str, message: &str) -> HrError {
    coded(
        KernelError::validation(message.to_owned())
            .with_code(code)
            .with_field(field),
    )
}

/// The trimmed label, 1 to 60 characters.
pub(super) fn label(raw: &str) -> Result<String, HrError> {
    let label = raw.trim();
    if label.is_empty() || label.chars().count() > LABEL_MAX || label.chars().any(char::is_control)
    {
        return Err(invalid(
            "label",
            "roster_field_label_invalid",
            "label must be 1 to 60 characters",
        ));
    }
    Ok(label.to_owned())
}

fn choices_invalid(message: &str) -> HrError {
    invalid("choices", "roster_field_choices_invalid", message)
}

/// The options a field ends with: every option of `current` (relabelled when
/// sent with its id), then each new one with a fresh id. A CHOICE field has 1
/// to 50 options with distinct labels; any other type has none.
pub(super) fn choices(
    value_type: &str,
    current: &[RosterFieldChoice],
    sent: Vec<RosterFieldChoiceInput>,
) -> Result<Vec<RosterFieldChoice>, HrError> {
    if value_type != "CHOICE" {
        return if sent.is_empty() {
            Ok(Vec::new())
        } else {
            Err(choices_invalid("only a CHOICE field has options"))
        };
    }
    if sent.is_empty() || sent.len() > CHOICE_MAX {
        return Err(choices_invalid("a CHOICE field has 1 to 50 options"));
    }
    let mut out = Vec::with_capacity(sent.len());
    for input in sent {
        let label = input.label.trim();
        if label.is_empty()
            || label.chars().count() > CHOICE_LABEL_MAX
            || label.chars().any(char::is_control)
        {
            return Err(choices_invalid("an option label is 1 to 40 characters"));
        }
        if out
            .iter()
            .any(|c: &RosterFieldChoice| c.label.to_lowercase() == label.to_lowercase())
        {
            return Err(choices_invalid("option labels must differ"));
        }
        let id = match input.id {
            Some(id) if current.iter().any(|c| c.id == id) && !out.iter().any(|c| c.id == id) => id,
            Some(_) => {
                return Err(choices_invalid(
                    "an option id must name an existing option once",
                ));
            }
            None => Uuid::new_v4(),
        };
        out.push(RosterFieldChoice {
            id,
            label: label.to_owned(),
        });
    }
    if current.iter().any(|c| !out.iter().any(|o| o.id == c.id)) {
        return Err(choices_invalid("an option is never removed"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn input(id: Option<Uuid>, label: &str) -> RosterFieldChoiceInput {
        RosterFieldChoiceInput {
            id,
            label: label.to_owned(),
        }
    }

    fn code(r: Result<Vec<RosterFieldChoice>, HrError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn labels_are_trimmed_and_bounded() {
        assert_eq!(label("  사번 구분 ").unwrap(), "사번 구분");
        assert_eq!(label(" ").unwrap_err().code, "roster_field_label_invalid");
        assert_eq!(
            label(&"가".repeat(61)).unwrap_err().code,
            "roster_field_label_invalid"
        );
        assert_eq!(
            label("a\nb").unwrap_err().code,
            "roster_field_label_invalid"
        );
    }

    #[test]
    fn only_a_choice_field_has_options() {
        assert!(choices("TEXT", &[], vec![]).unwrap().is_empty());
        assert_eq!(
            code(choices("TEXT", &[], vec![input(None, "A")])),
            "roster_field_choices_invalid"
        );
        assert_eq!(
            code(choices("CHOICE", &[], vec![])),
            "roster_field_choices_invalid"
        );
        let many = (0..51).map(|i| input(None, &format!("o{i}"))).collect();
        assert_eq!(
            code(choices("CHOICE", &[], many)),
            "roster_field_choices_invalid"
        );
        assert_eq!(
            code(choices(
                "CHOICE",
                &[],
                vec![input(None, "A"), input(None, " a ")]
            )),
            "roster_field_choices_invalid"
        );
    }

    #[test]
    fn a_change_keeps_every_option_and_its_id() {
        let first = choices(
            "CHOICE",
            &[],
            vec![input(None, "통근"), input(None, "기숙사")],
        )
        .unwrap();
        let (a, b) = (first[0].id, first[1].id);
        let next = choices(
            "CHOICE",
            &first,
            vec![
                input(Some(b), "사내 기숙사"),
                input(Some(a), "통근"),
                input(None, "자가"),
            ],
        )
        .unwrap();
        assert_eq!(
            next[0],
            RosterFieldChoice {
                id: b,
                label: "사내 기숙사".into()
            }
        );
        assert_eq!(next[1].id, a);
        assert!(next[2].id != a && next[2].id != b);
        // Dropping an option, naming an unknown id, or naming one twice is refused.
        assert_eq!(
            code(choices("CHOICE", &first, vec![input(Some(a), "통근")])),
            "roster_field_choices_invalid"
        );
        assert_eq!(
            code(choices(
                "CHOICE",
                &first,
                vec![
                    input(Some(a), "통근"),
                    input(Some(b), "x"),
                    input(Some(Uuid::new_v4()), "y")
                ]
            )),
            "roster_field_choices_invalid"
        );
        assert_eq!(
            code(choices(
                "CHOICE",
                &first,
                vec![
                    input(Some(a), "통근"),
                    input(Some(a), "x"),
                    input(Some(b), "y")
                ]
            )),
            "roster_field_choices_invalid"
        );
    }
}
