//! Every active layer, pattern and holiday of the tenant in memory, and the
//! resolution of one person (or one scope's default) on a date.
// whole-tenant load per request (layers and patterns are hundreds of
// rows at 2,000 people); a per-사업장 cache keyed by the schedule topic if it
// ever shows in p95.

use std::collections::HashMap;

use console_attendance_application::{calendar::ContractualHoliday, schedule::StoredSpec};
use console_attendance_domain::schedule::{
    BreakFloorRow, DayPlan, HolidayFact, HolidayKind, LayerRef, Level, plan_day, winner,
};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::ScheduleStoreError;
use super::holidays::{load_contractual, load_public};
use super::org::{OrgModel, Person};

#[derive(Debug, Clone)]
pub(crate) struct StoredLayer {
    pub id: Uuid,
    pub level: Level,
    pub scope_id: Uuid,
    pub pattern_id: Uuid,
    pub from: Date,
    pub to: Option<Date>,
    pub version: i32,
    pub rotation_start: Option<Date>,
    pub start_choice: Option<u16>,
}

#[derive(Debug, Clone)]
pub(crate) struct PatternRow {
    pub name: String,
    pub spec: StoredSpec,
    pub active: bool,
}

pub(crate) struct Universe {
    pub org: OrgModel,
    pub layers: Vec<StoredLayer>,
    pub patterns: HashMap<Uuid, PatternRow>,
    pub public: HashMap<Date, HolidayFact>,
    pub contractual: Vec<ContractualHoliday>,
    pub loaded_years: Vec<i32>,
    pub floors: Vec<BreakFloorRow>,
}

pub(crate) const LAYER_COLUMNS: &str = "id, scope_kind, COALESCE(legal_entity_id, workplace_id, org_unit_id, crew_id, employee_id) AS scope_id, \
     pattern_id, effective_from, effective_to, version, rotation_start, start_choice";

pub(crate) fn layer_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<StoredLayer, ScheduleStoreError> {
    let kind: String = row.try_get("scope_kind")?;
    let choice: Option<i16> = row.try_get("start_choice")?;
    Ok(StoredLayer {
        id: row.try_get("id")?,
        level: Level::parse(&kind).ok_or(ScheduleStoreError::Corrupt("scope_kind"))?,
        scope_id: row.try_get("scope_id")?,
        pattern_id: row.try_get("pattern_id")?,
        from: row.try_get("effective_from")?,
        to: row.try_get("effective_to")?,
        version: row.try_get("version")?,
        rotation_start: row.try_get("rotation_start")?,
        start_choice: choice.and_then(|c| u16::try_from(c).ok()),
    })
}

impl Universe {
    pub(crate) async fn load(
        tx: &mut Transaction<'_, Postgres>,
        org: OrgModel,
        years: (i32, i32),
    ) -> Result<Self, ScheduleStoreError> {
        let sql = format!(
            "SELECT {LAYER_COLUMNS} FROM attendance_schedule_layers WHERE status = 'ACTIVE'"
        );
        let layers = sqlx::query(sqlx::AssertSqlSafe(&*sql))
            .fetch_all(tx.as_mut())
            .await?
            .iter()
            .map(layer_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let mut patterns = HashMap::new();
        for row in sqlx::query("SELECT id, name, spec, status FROM attendance_work_patterns")
            .fetch_all(tx.as_mut())
            .await?
        {
            let spec: serde_json::Value = row.try_get("spec")?;
            let status: String = row.try_get("status")?;
            patterns.insert(
                row.try_get::<Uuid, _>("id")?,
                PatternRow {
                    name: row.try_get("name")?,
                    spec: serde_json::from_value(spec)
                        .map_err(|_| ScheduleStoreError::Corrupt("spec"))?,
                    active: status == "ACTIVE",
                },
            );
        }
        let (public, loaded_years) = load_public(tx, years).await?;
        let contractual = load_contractual(tx).await?;
        let floors = super::break_floor::load(tx).await?;
        Ok(Self {
            org,
            layers,
            patterns,
            public,
            contractual,
            loaded_years,
            floors,
        })
    }

    /// The layers that reach `p`, with 부서 depth.
    pub(crate) fn layers_for(&self, p: &Person) -> Vec<LayerRef> {
        let chain = p.unit.map(|u| self.org.chain(u)).unwrap_or_default();
        self.layers
            .iter()
            .filter_map(|l| {
                let depth = match l.level {
                    Level::Person => (l.scope_id == p.id).then_some(0),
                    Level::Crew => (Some(l.scope_id) == p.crew).then_some(0),
                    Level::Department => chain
                        .iter()
                        .find(|(u, _)| *u == l.scope_id)
                        .map(|(_, d)| *d),
                    Level::Workplace => (Some(l.scope_id) == p.workplace_id).then_some(0),
                    Level::LegalEntity => (Some(l.scope_id) == p.legal_entity_id).then_some(0),
                }?;
                Some(LayerRef {
                    id: l.id,
                    level: l.level,
                    depth,
                    pattern_id: l.pattern_id,
                    effective_from: l.from,
                    effective_to: l.to,
                    version: l.version,
                    rotation_start: l.rotation_start,
                    start_choice: l.start_choice,
                })
            })
            .collect()
    }

    /// The holiday on `date` for a person at this 법인 / 사업장.
    pub(crate) fn holiday(&self, p: &Person, date: Date) -> Option<HolidayFact> {
        if let Some(h) = self.public.get(&date) {
            return Some(h.clone());
        }
        self.contractual
            .iter()
            .filter(|c| match c.scope_kind.as_str() {
                "LEGAL_ENTITY" => Some(c.scope_id) == p.legal_entity_id,
                _ => Some(c.scope_id) == p.workplace_id,
            })
            .find(|c| c.date_in(date.year()) == Some(date))
            .map(|c| HolidayFact {
                name: c.name.clone(),
                kind: HolidayKind::Contractual,
            })
    }

    /// The deciding layer and the day it gives `p` on `date`.
    pub(crate) fn day(
        &self,
        p: &Person,
        refs: &[LayerRef],
        date: Date,
    ) -> (Option<LayerRef>, DayPlan) {
        let holiday = self.holiday(p, date);
        let Some(w) = winner(refs, date) else {
            return (None, DayPlan::unscheduled(holiday.as_ref()));
        };
        let plan = self.patterns.get(&w.pattern_id).map_or_else(
            || DayPlan::unscheduled(holiday.as_ref()),
            |pat| {
                plan_day(
                    &pat.spec.pattern,
                    pat.spec.holiday_rule,
                    w,
                    date,
                    holiday.as_ref(),
                )
            },
        );
        (Some(w.clone()), plan)
    }

    /// A pseudo-person standing for a scope's default (no nearer layer).
    pub(crate) fn stand_in(&self, level: Level, id: Uuid) -> Option<Person> {
        let mut p = Person {
            id: Uuid::nil(),
            number: None,
            name: String::new(),
            legal_entity_id: None,
            workplace_id: None,
            unit: None,
            crew: None,
        };
        let workplace = match level {
            Level::LegalEntity => {
                self.org.entities.contains_key(&id).then_some(())?;
                p.legal_entity_id = Some(id);
                return Some(p);
            }
            Level::Workplace => Some(id),
            Level::Department => {
                p.unit = Some(id);
                self.org.workplace_of_unit(id)
            }
            Level::Crew => {
                p.crew = Some(id);
                self.org.crews.get(&id).map(|(w, _)| *w)
            }
            Level::Person => return None,
        };
        let wp = self.org.workplaces.get(&workplace?)?;
        p.workplace_id = workplace;
        p.legal_entity_id = Some(wp.legal_entity_id);
        Some(p)
    }

    pub(crate) fn holidays_loaded(&self, year: i32) -> bool {
        self.loaded_years.contains(&year)
    }
}

/// Today in KST.
pub(crate) fn today_kst() -> Date {
    (OffsetDateTime::now_utc() + time::Duration::hours(9)).date()
}
