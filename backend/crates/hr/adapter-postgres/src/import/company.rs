//! r3:hire-01: the 법인 text (`employees.company`, the display snapshot) of a
//! person an import inserts. It is the name of the 법인 of the 사업장 the
//! plan places them at, as a registration writes it; with no 사업장 it is
//! 「법인 미정」 until someone places them. Never the sheet's name, never a
//! free-text guess.

use std::collections::BTreeMap;

use console_entity_adapter_postgres::employment_moves::{entity_label, open_workplace_entity};
use console_hr_domain::import::plan::PlannedRow;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::lifecycle::title_reason::coded;

/// The text of a person whose 법인 nobody decided (the column is NOT NULL
/// and non-blank; the 미배치 queue and the roster show them 법인 미정).
pub use console_hr_domain::import::plan::ENTITY_UNDECIDED;

pub(super) fn proposals(
    row: &console_hr_domain::import::plan::ImportRow,
    confirmed: &[console_entity_adapter_postgres::name_evidence::CompanyCandidate],
) -> Vec<console_hr_domain::import::names::NameCandidate> {
    confirmed
        .iter()
        .filter_map(|c| {
            let names: Vec<_> = std::iter::once(c.name.as_str())
                .chain(c.alias.as_deref())
                .chain(c.matching_names.iter().map(String::as_str))
                .collect();
            console_hr_domain::import::company_review::candidate_basis(
                row,
                &c.registration_numbers,
                &names,
            )
            .map(|basis| console_hr_domain::import::names::NameCandidate {
                alias: c.alias.clone(),
                id: c.workplace_id,
                name: c.name.clone(),
                basis,
            })
        })
        .collect()
}

/// 사업장 id → the name of its 법인 today, for every 사업장 the plan places
/// a new person at.
///
/// # Errors
/// 422 `workplace_not_open` when a 사업장 closed after the re-plan; a
/// database fault.
pub async fn entity_names(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    plan: &[PlannedRow],
) -> Result<BTreeMap<Uuid, String>, HrError> {
    let mut names = BTreeMap::new();
    for workplace in plan
        .iter()
        .filter_map(|row| row.new_person.as_ref()?.workplace_id)
    {
        if names.contains_key(&workplace) {
            continue;
        }
        let entity = open_workplace_entity(tx.as_mut(), org, workplace)
            .await
            .map_err(coded)?;
        let name = entity_label(tx.as_mut(), org, entity, today_kst())
            .await
            .map_err(coded)?
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| ENTITY_UNDECIDED.to_owned());
        names.insert(workplace, name);
    }
    Ok(names)
}

/// The 법인 text of one planned new person.
#[must_use]
pub fn company_of(workplace: Option<Uuid>, names: &BTreeMap<Uuid, String>) -> String {
    workplace
        .and_then(|w| names.get(&w).cloned())
        .unwrap_or_else(|| ENTITY_UNDECIDED.to_owned())
}

/// Revalidated on dry run and apply: aliases cannot attach to unconfirmed employers.
pub async fn company_places(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    decisions: &console_hr_domain::import::plan::Decisions,
) -> Result<BTreeMap<String, Vec<Uuid>>, HrError> {
    let confirmed = console_entity_adapter_postgres::name_evidence::company_candidates(tx, org)
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    let mut places = BTreeMap::new();
    for (key, id) in &decisions.company_map {
        let Some(id) = id else {
            continue;
        };
        let candidate = confirmed
            .iter()
            .find(|c| c.workplace_id == *id)
            .ok_or_else(|| {
                coded(
                    console_kernel_core::KernelError::validation(
                        "the company candidate is not certificate-confirmed",
                    )
                    .with_code("entity_certificate_unconfirmed")
                    .with_field("company_map"),
                )
            })?;
        places.insert(key.clone(), candidate.workplaces.clone());
    }
    Ok(places)
}

#[cfg(test)]
mod tests {
    use super::{ENTITY_UNDECIDED, company_of};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    #[test]
    fn a_placed_person_takes_the_entity_name_and_an_unplaced_one_is_undecided() {
        let w = Uuid::new_v4();
        let names = BTreeMap::from([(w, "주식회사 한빛".to_owned())]);
        assert_eq!(company_of(Some(w), &names), "주식회사 한빛");
        assert_eq!(company_of(None, &names), ENTITY_UNDECIDED);
        assert_eq!(company_of(Some(Uuid::new_v4()), &names), ENTITY_UNDECIDED);
    }
}
