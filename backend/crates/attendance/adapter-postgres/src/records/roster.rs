//! Who is placed where on each day of a range: dated assignments (법인 ·
//! 사업장) and dated 근무조, with today's 부서 (the dated 부서 read is the
//! org-history reader's; see `schedule::org`).

use std::collections::BTreeMap;

use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use crate::schedule::ScheduleStoreError;
use crate::schedule::org::Person;

#[derive(Debug, Clone)]
struct Span<T> {
    from: Date,
    to: Option<Date>,
    value: T,
}

fn covering<T: Copy>(spans: &[Span<T>], date: Date) -> Option<T> {
    spans
        .iter()
        .find(|s| s.from <= date && s.to.is_none_or(|t| date < t))
        .map(|s| s.value)
}

#[derive(Debug, Clone)]
pub(crate) struct Member {
    pub id: Uuid,
    pub number: Option<String>,
    pub name: String,
    pub unit: Option<Uuid>,
    hire_on: Option<Date>,
    exit_on: Option<Date>,
    places: Vec<Span<(Option<Uuid>, Option<Uuid>)>>,
    crews: Vec<Span<Uuid>>,
}

impl Member {
    pub(crate) fn setting_entities(&self) -> impl Iterator<Item = Option<Uuid>> + '_ {
        self.places.iter().map(|span| span.value.0)
    }

    /// The person as placed on `date`, or nobody when not employed there.
    pub fn on(&self, date: Date) -> Option<Person> {
        if self.hire_on.is_some_and(|h| date < h) || self.exit_on.is_some_and(|x| date > x) {
            return None;
        }
        let (legal_entity_id, workplace_id) = covering(&self.places, date)?;
        Some(Person {
            id: self.id,
            number: self.number.clone(),
            name: self.name.clone(),
            legal_entity_id,
            workplace_id,
            unit: self.unit,
            crew: covering(&self.crews, date),
        })
    }
}

const PEOPLE_SQL: &str = "SELECT e.id, e.employee_number, e.name, e.org_unit_id, e.hire_on, e.exit_on, \
     a.legal_entity_id, a.workplace_id, a.valid_from, a.valid_to \
     FROM employees e JOIN employment_assignments a ON a.org_id = e.org_id AND a.employee_id = e.id \
      AND a.superseded_at IS NULL AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $1) \
     WHERE e.merged_into_employee_id IS NULL AND e.employment_status <> 'VOIDED' \
       AND (e.hire_on IS NULL OR e.hire_on <= $2) AND (e.exit_on IS NULL OR e.exit_on >= $1) \
       AND ($3::uuid[] IS NULL OR e.id = ANY($3)) \
     ORDER BY e.employee_number NULLS LAST, e.name, e.id, a.valid_from";
const CREWS_SQL: &str = "SELECT employee_id, crew_id, valid_from, valid_to FROM attendance_crew_members \
     WHERE valid_from <= $2 AND (valid_to IS NULL OR valid_to > $1) AND ($3::uuid[] IS NULL OR employee_id = ANY($3))";

/// Everyone employed at some point of [first, last], in 사번 order.
pub(crate) async fn load_members(
    tx: &mut Transaction<'_, Postgres>,
    first: Date,
    last: Date,
    only: Option<&[Uuid]>,
) -> Result<Vec<Member>, ScheduleStoreError> {
    let only: Option<Vec<Uuid>> = only.map(<[Uuid]>::to_vec);
    let rows = sqlx::query(PEOPLE_SQL)
        .bind(first)
        .bind(last)
        .bind(&only)
        .fetch_all(tx.as_mut())
        .await?;
    let mut order: Vec<Uuid> = Vec::new();
    let mut by_id: BTreeMap<Uuid, Member> = BTreeMap::new();
    for r in rows {
        let id: Uuid = r.try_get("id")?;
        let place = Span {
            from: r.try_get("valid_from")?,
            to: r.try_get("valid_to")?,
            value: (r.try_get("legal_entity_id")?, r.try_get("workplace_id")?),
        };
        if let Some(m) = by_id.get_mut(&id) {
            m.places.push(place);
            continue;
        }
        order.push(id);
        by_id.insert(
            id,
            Member {
                id,
                number: r.try_get("employee_number")?,
                name: r.try_get("name")?,
                unit: r.try_get("org_unit_id")?,
                hire_on: r.try_get("hire_on")?,
                exit_on: r.try_get("exit_on")?,
                places: vec![place],
                crews: Vec::new(),
            },
        );
    }
    for r in sqlx::query(CREWS_SQL)
        .bind(first)
        .bind(last)
        .bind(&only)
        .fetch_all(tx.as_mut())
        .await?
    {
        let id: Uuid = r.try_get("employee_id")?;
        if let Some(m) = by_id.get_mut(&id) {
            m.crews.push(Span {
                from: r.try_get("valid_from")?,
                to: r.try_get("valid_to")?,
                value: r.try_get("crew_id")?,
            });
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
}

/// The caller's own employee record, whose 근태 they may read but not write.
pub(crate) async fn own_employee(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
) -> Result<Option<Uuid>, ScheduleStoreError> {
    Ok(
        sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
            .bind(user)
            .fetch_optional(tx.as_mut())
            .await?
            .flatten(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn a_member_is_placed_by_the_assignment_covering_the_day() {
        let (a, b, crew) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let m = Member {
            id: Uuid::from_u128(9),
            number: None,
            name: "x".into(),
            unit: None,
            hire_on: Some(date!(2026 - 01 - 02)),
            exit_on: Some(date!(2026 - 10 - 20)),
            places: vec![
                Span {
                    from: date!(2026 - 01 - 02),
                    to: Some(date!(2026 - 10 - 10)),
                    value: (None, Some(a)),
                },
                Span {
                    from: date!(2026 - 10 - 10),
                    to: None,
                    value: (None, Some(b)),
                },
            ],
            crews: vec![Span {
                from: date!(2026 - 10 - 12),
                to: None,
                value: crew,
            }],
        };
        assert_eq!(m.on(date!(2026 - 10 - 09)).unwrap().workplace_id, Some(a));
        let p = m.on(date!(2026 - 10 - 12)).unwrap();
        assert_eq!((p.workplace_id, p.crew), (Some(b), Some(crew)));
        assert!(m.on(date!(2026 - 10 - 21)).is_none(), "after 퇴직");
        assert!(m.on(date!(2026 - 01 - 01)).is_none(), "before 입사");
    }
}
