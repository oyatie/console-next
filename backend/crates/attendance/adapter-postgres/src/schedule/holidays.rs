//! 공휴일 (bundled reference rows, read-only) and 약정휴일.

use std::collections::HashMap;

use console_attendance_application::CallerScope;
use console_attendance_application::calendar::{ContractualHoliday, HolidayYear, PublicHoliday};

use console_attendance_domain::schedule::{HolidayFact, HolidayKind};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;

use sqlx::{Postgres, Row, Transaction};
use time::Date;

use super::org::load_org;

use super::ScheduleStoreError;
use super::universe::Universe;
use crate::PgAttendanceStore;

const PUBLIC_SQL: &str = "SELECT holiday_date, name, kind, substitute_for, basis, edition FROM attendance_public_holidays \
     WHERE holiday_date >= make_date($1, 1, 1) AND holiday_date < make_date($2 + 1, 1, 1) ORDER BY holiday_date";
const CONTRACTUAL_SQL: &str = "SELECT h.id, h.name, h.rule_kind, h.on_date, h.month, h.day, h.paid, h.scope_kind, \
     COALESCE(h.legal_entity_id, h.workplace_id) AS scope_id, h.basis_kind, h.basis_ref, h.start_year, h.end_year, \
     h.created_at, COALESCE(u.display_name, '') AS created_by_name FROM attendance_contractual_holidays h \
     LEFT JOIN users u ON u.id = h.created_by AND u.org_id = h.org_id";

fn kind_of(raw: &str) -> HolidayKind {
    match raw {
        "SUBSTITUTE" => HolidayKind::Substitute,
        "ELECTION" => HolidayKind::Election,
        "LABOR_DAY" => HolidayKind::LaborDay,
        _ => HolidayKind::National,
    }
}

async fn public_rows(
    tx: &mut Transaction<'_, Postgres>,
    (y0, y1): (i32, i32),
) -> Result<Vec<(PublicHoliday, String)>, ScheduleStoreError> {
    let rows = sqlx::query(PUBLIC_SQL)
        .bind(y0)
        .bind(y1)
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter()
        .map(|r| {
            Ok((
                PublicHoliday {
                    date: r.try_get("holiday_date")?,
                    name: r.try_get("name")?,
                    kind: r.try_get("kind")?,
                    substitute_for: r.try_get("substitute_for")?,
                    basis: r.try_get("basis")?,
                },
                r.try_get("edition")?,
            ))
        })
        .collect()
}

pub(crate) async fn load_public(
    tx: &mut Transaction<'_, Postgres>,
    years: (i32, i32),
) -> Result<(HashMap<Date, HolidayFact>, Vec<i32>), ScheduleStoreError> {
    let rows = public_rows(tx, years).await?;
    let mut loaded: Vec<i32> = rows.iter().map(|(h, _)| h.date.year()).collect();
    loaded.dedup();
    let map = rows
        .into_iter()
        .map(|(h, _)| {
            (
                h.date,
                HolidayFact {
                    name: h.name,
                    kind: kind_of(&h.kind),
                },
            )
        })
        .collect();
    Ok((map, loaded))
}

pub(crate) async fn load_contractual(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<ContractualHoliday>, ScheduleStoreError> {
    let rows = sqlx::query(CONTRACTUAL_SQL).fetch_all(tx.as_mut()).await?;
    rows.iter()
        .map(|r| {
            Ok(ContractualHoliday {
                id: r.try_get("id")?,
                name: r.try_get("name")?,
                rule_kind: r.try_get("rule_kind")?,
                on_date: r.try_get("on_date")?,
                month: r.try_get("month")?,
                day: r.try_get("day")?,
                paid: r.try_get("paid")?,
                scope_kind: r.try_get("scope_kind")?,
                scope_id: r.try_get("scope_id")?,
                scope_name: String::new(),
                basis_kind: r.try_get("basis_kind")?,
                basis_ref: r.try_get("basis_ref")?,
                start_year: r.try_get("start_year")?,
                end_year: r.try_get("end_year")?,
                created_at: r.try_get("created_at")?,
                created_by_name: r.try_get("created_by_name")?,
            })
        })
        .collect()
}

pub(super) fn named(u: &Universe, mut h: ContractualHoliday) -> ContractualHoliday {
    h.scope_name = match h.scope_kind.as_str() {
        "LEGAL_ENTITY" => u.org.entities.get(&h.scope_id).cloned(),
        _ => u.org.workplaces.get(&h.scope_id).map(|w| w.name.clone()),
    }
    .unwrap_or_default();
    h
}

impl PgAttendanceStore {
    pub async fn holiday_year(
        &self,
        caller: &CallerScope,
        year: i32,
    ) -> Result<HolidayYear, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let public = public_rows(tx, (year, year)).await?;
                    let edition = public.first().map(|(_, e)| e.clone());
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (year, year)).await?;
                    let seen = |h: &ContractualHoliday| {
                        caller.org_wide
                            || (h.scope_kind == "WORKPLACE"
                                && caller.permits_branch(
                                    u.org.workplaces.get(&h.scope_id).and_then(|w| w.branch_id),
                                ))
                            || (h.scope_kind == "LEGAL_ENTITY"
                                && u.org.workplaces.values().any(|w| {
                                    w.legal_entity_id == h.scope_id
                                        && caller.permits_branch(w.branch_id)
                                }))
                    };
                    let contractual = u
                        .contractual
                        .iter()
                        .filter(|h| h.date_in(year).is_some() && seen(h))
                        .cloned()
                        .map(|h| named(&u, h))
                        .collect();
                    Ok(HolidayYear {
                        year,
                        loaded: edition.is_some(),
                        edition,
                        public: public.into_iter().map(|(h, _)| h).collect(),
                        contractual,
                    })
                })
            },
        )
        .await
    }
}
