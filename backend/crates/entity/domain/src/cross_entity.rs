//! The 업무위탁 basis of a scope grant on another 법인 (decisions #15.2).
//!
//! A grant is an ordinary grant whatever 법인 employs its holder (#15.3).
//! Only when the tenant setting `authz.cross_entity_grant.basis_required` is
//! on (the default) does a grant whose holder is not employed by the target
//! 법인 need its basis: the 업무위탁 contract reference and date, which feed
//! that 법인's 수탁자 list for its 처리방침 (개인정보 보호법 §26②). A tenant
//! that turns it off tracks no basis (its own responsibility, #15.2).

use serde::{Deserialize, Serialize};

use crate::{Issues, Refusal};

/// The basis as typed with a grant.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantBasisInput {
    /// 업무위탁 계약 reference (e.g. a contract number), 1–200 characters.
    pub basis_ref: Option<String>,
    /// 업무위탁 계약일, `YYYY-MM-DD`, not after today.
    pub basis_date: Option<String>,
}

/// A validated basis, stored on the grant (both or neither).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GrantBasis {
    pub basis_ref: String,
    pub basis_date: time::Date,
}

/// Validate the basis of a grant on the target 법인.
///
/// `required` is the resolved setting; `holder_employed_by_target` whether an
/// open employment of the holder sits at that 법인 (a TENANT grant counts as
/// employed: it targets no single 법인). A basis given when none is needed is
/// still validated and kept, so a tenant may record one voluntarily.
///
/// # Errors
/// `basis_ref` / `basis_date` field issues: `required` when the basis is
/// needed and missing, `basis_incomplete` for one half alone, or the text and
/// date checks (`too_long`, `invalid_date`, `after_latest`).
pub fn check_grant_basis(
    required: bool,
    holder_employed_by_target: bool,
    input: &GrantBasisInput,
    today: time::Date,
) -> Result<Option<GrantBasis>, Refusal> {
    let needed = required && !holder_employed_by_target;
    let given = input
        .basis_ref
        .as_deref()
        .is_some_and(|r| !r.trim().is_empty())
        || input
            .basis_date
            .as_deref()
            .is_some_and(|d| !d.trim().is_empty());
    if !needed && !given {
        return Ok(None);
    }
    let mut is = Issues::default();
    let basis_ref = is.text("basis_ref", input.basis_ref.as_deref(), 200, true);
    let basis_date = is.date("basis_date", input.basis_date.as_deref(), true, Some(today));
    if given && !needed && (basis_ref.is_none() || basis_date.is_none()) {
        // One half alone is never stored (the table keeps both or neither).
        let mut half = Issues::default();
        let field = if basis_ref.is_none() {
            "basis_ref"
        } else {
            "basis_date"
        };
        half.push(field, "basis_incomplete");
        return half.finish(|| None);
    }
    is.finish_opt(|| {
        Some(Some(GrantBasis {
            basis_ref: basis_ref?,
            basis_date: basis_date?,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    const TODAY: time::Date = date!(2026 - 10 - 05);

    fn basis(r: Option<&str>, d: Option<&str>) -> GrantBasisInput {
        GrantBasisInput {
            basis_ref: r.map(Into::into),
            basis_date: d.map(Into::into),
        }
    }

    fn fields(err: Refusal) -> Vec<(String, &'static str)> {
        err.fields.into_iter().map(|f| (f.field, f.code)).collect()
    }

    #[test]
    fn another_entitys_holder_needs_the_basis_while_the_setting_is_on() {
        let err = check_grant_basis(true, false, &basis(None, None), TODAY).unwrap_err();
        assert_eq!(
            fields(err),
            vec![
                ("basis_ref".into(), "required"),
                ("basis_date".into(), "required")
            ]
        );
        let ok = check_grant_basis(
            true,
            false,
            &basis(Some(" 위탁-2026-01 "), Some("2026-09-01")),
            TODAY,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (ok.basis_ref.as_str(), ok.basis_date),
            ("위탁-2026-01", date!(2026 - 09 - 01))
        );
    }

    #[test]
    fn the_holders_own_employer_or_a_tenant_that_opted_out_needs_none() {
        assert_eq!(
            check_grant_basis(true, true, &basis(None, None), TODAY).unwrap(),
            None
        );
        assert_eq!(
            check_grant_basis(false, false, &basis(None, None), TODAY).unwrap(),
            None
        );
        // Given voluntarily: kept, and never half of it.
        assert!(
            check_grant_basis(false, false, &basis(Some("x"), Some("2026-01-02")), TODAY)
                .unwrap()
                .is_some()
        );
        let err = check_grant_basis(false, true, &basis(Some("x"), None), TODAY).unwrap_err();
        assert_eq!(fields(err), vec![("basis_date".into(), "basis_incomplete")]);
    }

    #[test]
    fn a_future_contract_date_is_refused() {
        let err = check_grant_basis(true, false, &basis(Some("x"), Some("2026-10-06")), TODAY)
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "basis_date");
    }
}
