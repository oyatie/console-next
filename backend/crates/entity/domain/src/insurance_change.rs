//! A dated change to a 사업장's 4대보험 relations (the insurance PUT): only the
//! insurers listed change; each is validated as on creation.

use crate::codes::Insurer;
use crate::insurance::{InsuranceDraft, InsurerInput, validate_insurer};
use crate::refusal::{Issues, NOT_APPLICABLE, REQUIRED, Refusal};

/// # Errors
/// 422: no insurer listed, an unknown or repeated insurer, a relation that
/// points at the 사업장 itself, or any field issue of one insurer.
pub fn validate_insurance_change(
    workplace: uuid::Uuid,
    insurers: &[InsurerInput],
) -> Result<Vec<InsuranceDraft>, Refusal> {
    let mut is = Issues::default();
    if insurers.is_empty() {
        is.push("insurers", REQUIRED);
    }
    let mut seen = Vec::new();
    let mut drafts = Vec::new();
    for (idx, input) in insurers.iter().enumerate() {
        let field = format!("insurers[{idx}]");
        let Some(insurer) = is.choice(
            &format!("{field}.insurer"),
            input.insurer.as_deref(),
            true,
            Insurer::parse,
        ) else {
            continue;
        };
        if seen.contains(&insurer) {
            is.push(format!("{field}.insurer"), "duplicate");
            continue;
        }
        seen.push(insurer);
        if input.main_workplace_id == Some(workplace) {
            is.push(format!("{field}.main_workplace_id"), NOT_APPLICABLE);
        }
        if let Some(d) = validate_insurer(&mut is, &field, input, insurer, None) {
            drafts.push(d);
        }
    }
    is.finish(|| drafts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nps(status: &str) -> InsurerInput {
        InsurerInput {
            insurer: Some("NPS".into()),
            status: Some(status.into()),
            ..InsurerInput::default()
        }
    }

    #[test]
    fn only_listed_insurers_change_and_each_is_validated() {
        let me = uuid::Uuid::new_v4();
        let ok = validate_insurance_change(me, &[nps("NOT_ESTABLISHED")]).unwrap();
        assert_eq!((ok.len(), ok[0].insurer), (1, Insurer::Nps));
        let fields = |r: Result<Vec<InsuranceDraft>, Refusal>| {
            r.unwrap_err()
                .fields
                .into_iter()
                .map(|f| (f.field, f.code))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fields(validate_insurance_change(me, &[])),
            vec![("insurers".to_owned(), "required")]
        );
        assert_eq!(
            fields(validate_insurance_change(
                me,
                &[nps("NOT_ESTABLISHED"), nps("NOT_ESTABLISHED")]
            )),
            vec![("insurers[1].insurer".to_owned(), "duplicate")]
        );
        // ESTABLISHED needs its 관리번호 and 성립일.
        let missing = fields(validate_insurance_change(me, &[nps("ESTABLISHED")]));
        assert!(
            missing
                .iter()
                .any(|(f, c)| f == "insurers[0].mgmt_no" && *c == "required"),
            "{missing:?}"
        );
        let selfref = InsurerInput {
            unit_mode: Some("PART_OF".into()),
            main_workplace_id: Some(me),
            ..nps("NOT_ESTABLISHED")
        };
        assert!(
            fields(validate_insurance_change(me, &[selfref]))
                .iter()
                .any(|(f, _)| f == "insurers[0].main_workplace_id")
        );
    }
}
