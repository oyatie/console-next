//! Chart-only membership coordinates for dated counts; no employee read API is exposed.
use crate::{PgEntityError, Tx};
use console_entity_application::ReadPoint;
use sqlx::Row;
use uuid::Uuid;

pub(crate) struct Membership {
    pub employee: Uuid,
    pub unit: Option<Uuid>,
    pub entity: Option<Uuid>,
    pub workplace: Option<Uuid>,
    pub dispatched: bool,
    pub projected: bool,
}

pub(crate) async fn load(
    tx: &mut Tx<'_>,
    point: ReadPoint,
) -> Result<Vec<Membership>, PgEntityError> {
    // A newly recorded backdated exit supersedes the canonical snapshot's stale status.
    // One count rule for chart, list, compare and export: employed on D iff 입사일 <= D < 퇴직일,
    // where 퇴직일 (the exit's effective date) = 마지막 근무일 + 1 = 4대보험 상실일.
    let rows = sqlx::query(
        "WITH known_events AS MATERIALIZED ( \
           SELECT * FROM employee_lifecycle_events WHERE $2::timestamptz IS NULL UNION ALL \
           SELECT (jsonb_populate_record(NULL::employee_lifecycle_events, entity_known_row(to_jsonb(x), $2))).* \
           FROM employee_lifecycle_events x WHERE $2::timestamptz IS NOT NULL), \
         events AS MATERIALIZED (SELECT x.* FROM known_events x WHERE x.id IS NOT NULL \
           AND x.state NOT IN ('CANCELLED','APPLY_FAILED') AND x.event_type <> 'RESCIND' \
           AND x.id NOT IN (SELECT v.voids_event_id FROM known_events v WHERE v.voids_event_id IS NOT NULL \
               AND v.state NOT IN ('CANCELLED','APPLY_FAILED'))) \
         , first_events AS (SELECT DISTINCT ON (employee_id) * FROM events ORDER BY employee_id,effective_date,created_at,id), \
         latest_status AS (SELECT DISTINCT ON (employee_id) * FROM events WHERE entity_try_iso_date(effective_date) <= $1 ORDER BY employee_id,effective_date DESC,created_at DESC,id DESC), \
         latest_unit AS (SELECT DISTINCT ON (employee_id) * FROM events WHERE entity_try_iso_date(effective_date) <= $1 \
             AND (to_org_unit_id IS NOT NULL OR to_org_unit IS DISTINCT FROM from_org_unit) ORDER BY employee_id,effective_date DESC,created_at DESC,id DESC), \
         latest_workplace AS (SELECT DISTINCT ON (employee_id) * FROM events WHERE entity_try_iso_date(effective_date) <= $1 \
             AND to_workplace_id IS NOT NULL ORDER BY employee_id,effective_date DESC,created_at DESC,id DESC), \
         latest_type AS (SELECT DISTINCT ON (employee_id) * FROM events WHERE entity_try_iso_date(effective_date) <= $1 \
             AND to_employment_type IS NOT NULL ORDER BY employee_id,effective_date DESC,created_at DESC,id DESC), \
         first_types AS (SELECT DISTINCT ON (employee_id) * FROM events WHERE to_employment_type IS NOT NULL ORDER BY employee_id,effective_date,created_at,id), \
         revisions AS (SELECT DISTINCT ON (b.employee_id) b.employee_id,x.attributes,x.valid_from,x.created_at FROM employment_source_bindings b \
             JOIN employment_revisions x ON x.employment_id=b.employment_id \
             WHERE x.valid_from < (($1::date+1)::timestamp AT TIME ZONE 'Asia/Seoul') AND x.created_at <= COALESCE($2::timestamptz,now()) \
             ORDER BY b.employee_id,x.valid_from DESC,x.version DESC), \
         assignments AS (SELECT DISTINCT ON (employee_id) employee_id,legal_entity_id,workplace_id,valid_from,created_at FROM employment_assignments \
             WHERE valid_from <= $1 AND created_at <= COALESCE($2::timestamptz,now()) \
             AND (superseded_at IS NULL OR superseded_at > $2) \
             AND (valid_to IS NULL OR valid_to > $1 OR valid_to_recorded_at > $2) ORDER BY employee_id,valid_from DESC,created_at DESC) \
         SELECT e.id, \
           CASE WHEN u.id IS NOT NULL AND (r.valid_from IS NULL OR (entity_try_iso_date(u.effective_date),u.created_at) >= ((r.valid_from AT TIME ZONE 'Asia/Seoul')::date,r.created_at)) THEN u.to_org_unit_id \
                WHEN r.attributes ? 'org_unit_id' THEN (r.attributes->>'org_unit_id')::uuid \
                WHEN first_event.id IS NOT NULL THEN first_event.from_org_unit_id ELSE e.org_unit_id END AS unit_id, \
           CASE WHEN w.id IS NOT NULL AND (a.employee_id IS NULL OR (entity_try_iso_date(w.effective_date),w.created_at) > (a.valid_from,a.created_at)) THEN wp.legal_entity_id ELSE a.legal_entity_id END AS legal_entity_id, \
           CASE WHEN w.id IS NOT NULL AND (a.employee_id IS NULL OR (entity_try_iso_date(w.effective_date),w.created_at) > (a.valid_from,a.created_at)) THEN w.to_workplace_id ELSE a.workplace_id END AS workplace_id, \
           COALESCE(t.to_employment_type,first_type.from_employment_type,CASE WHEN $2::timestamptz IS NULL THEN f.employment_type ELSE entity_known_row(to_jsonb(f),$2)->>'employment_type' END) \
               IN ('DISPATCHED_IN','OUTSOURCED_ON_SITE') AS dispatched \
         FROM employees e LEFT JOIN employee_employment_profiles f ON f.employee_id=e.id \
         LEFT JOIN revisions r ON r.employee_id=e.id \
         LEFT JOIN first_events first_event ON first_event.employee_id=e.id \
         LEFT JOIN latest_status l ON l.employee_id=e.id AND (r.valid_from IS NULL \
             OR l.event_type IN ('TERMINATE','OFFBOARD') AND l.created_at >= r.created_at \
             OR (entity_try_iso_date(l.effective_date),l.created_at) >= ((r.valid_from AT TIME ZONE 'Asia/Seoul')::date,r.created_at)) \
         LEFT JOIN latest_unit u ON u.employee_id=e.id \
         LEFT JOIN latest_workplace w ON w.employee_id=e.id \
         LEFT JOIN workplaces wp ON wp.id=w.to_workplace_id \
         LEFT JOIN latest_type t ON t.employee_id=e.id \
         LEFT JOIN first_types first_type ON first_type.employee_id=e.id \
         LEFT JOIN assignments a ON a.employee_id=e.id \
         WHERE e.created_at <= COALESCE($2::timestamptz,now()) \
           AND (NOT $3 OR e.employment_status NOT IN ('PRE_HIRE','EXITED','VOIDED')) \
           AND (r.valid_from IS NOT NULL OR first_event.event_type IN ('ONBOARD','REHIRE') AND entity_try_iso_date(first_event.effective_date) <= $1 \
               OR entity_try_iso_date(e.hire_date) IS NULL OR entity_try_iso_date(e.hire_date) <= $1) \
           AND CASE WHEN l.id IS NOT NULL THEN l.to_status NOT IN ('EXITED','VOIDED') \
               WHEN r.attributes ? 'employment_status' THEN r.attributes->>'employment_status' NOT IN ('EXITED','VOIDED') \
               WHEN first_event.id IS NOT NULL THEN first_event.from_status NOT IN ('EXITED','VOIDED') \
               ELSE e.employment_status NOT IN ('EXITED','VOIDED') OR NOT $3 AND entity_try_iso_date(e.exit_date) > $1 END",
    ).bind(point.as_of).bind(point.known_at).bind(point.live).fetch_all(tx.as_mut()).await?;
    rows.iter()
        .map(|r| {
            Ok(Membership {
                employee: r.try_get("id")?,
                projected: false,
                unit: r.try_get("unit_id")?,
                entity: r.try_get("legal_entity_id")?,
                workplace: r.try_get("workplace_id")?,
                dispatched: r.try_get::<Option<bool>, _>("dispatched")?.unwrap_or(false),
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(PgEntityError::from)
}

#[derive(Default)]
pub(crate) struct Counts {
    pub workplaces: std::collections::HashMap<Uuid, (i64, i64)>,
    pub unplaced: std::collections::HashMap<Uuid, (i64, i64)>,
    pub unknown: i64,
}

pub(crate) fn count(
    tree: &mut super::tree::Tree,
    members: &mut [Membership],
    sites: &std::collections::HashMap<Uuid, (Uuid, Uuid)>,
) -> Counts {
    let mut counts = Counts::default();
    let head_counts = tree.units.values().filter_map(|u| u.head.as_ref()).fold(
        std::collections::HashMap::new(),
        |mut counts, h| {
            *counts.entry(h.employee_id).or_insert(0) += 1;
            counts
        },
    );
    let member_units: std::collections::HashMap<_, _> =
        members.iter().map(|m| (m.employee, m.unit)).collect();
    for (id, u) in &mut tree.units {
        if let Some(h) = &mut u.head {
            h.concurrent = member_units
                .get(&h.employee_id)
                .is_some_and(|unit| *unit != Some(*id))
                || head_counts.get(&h.employee_id).is_some_and(|n| *n > 1);
        }
        u.direct = 0;
        u.dispatched = 0;
    }
    for m in members {
        if m.projected {
            let mut cursor = m.unit;
            let mut visited = std::collections::HashSet::new();
            while let Some(id) = cursor.filter(|id| visited.insert(*id)) {
                if let Some((e, w)) = sites.get(&id) {
                    m.entity = Some(*e);
                    m.workplace = Some(*w);
                    break;
                }
                cursor = tree.units.get(&id).and_then(|u| u.parent);
            }
        }
        if let Some(u) = m.unit.and_then(|id| tree.units.get_mut(&id)) {
            u.direct += 1;
            u.dispatched += i64::from(m.dispatched);
        }
        let bucket = match (m.entity, m.workplace) {
            (Some(_), Some(w)) => counts.workplaces.entry(w).or_default(),
            (Some(e), None) => counts.unplaced.entry(e).or_default(),
            (None, _) => {
                counts.unknown += 1;
                continue;
            }
        };
        bucket.0 += 1;
        bucket.1 += i64::from(m.dispatched);
    }
    counts
}

/// Placement coordinates are resolved before output scope filtering, so a move out stops counting at its source.
pub(crate) async fn sites(
    tx: &mut Tx<'_>,
    p: ReadPoint,
    represented: &std::collections::HashMap<Uuid, Uuid>,
) -> Result<std::collections::HashMap<Uuid, (Uuid, Uuid)>, PgEntityError> {
    let rows: Vec<(Uuid,Uuid)> = sqlx::query_as(
        "SELECT h.id,h.legal_entity_id FROM (SELECT (jsonb_populate_record(NULL::workplaces,entity_known_row(to_jsonb(w),$1))).* FROM workplaces w) h WHERE h.id IS NOT NULL",
    ).bind(p.known_at).fetch_all(tx.as_mut()).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(w, e)| represented.get(&w).map(|u| (*u, (e, w))))
        .collect())
}

/// Record headcounts use the same internal membership/projected placement as the chart.
pub(crate) async fn record_counts(
    tx: &mut Tx<'_>,
    p: ReadPoint,
    entities: &mut [console_entity_application::LegalEntityView],
) -> Result<(), PgEntityError> {
    let mut members = load(tx, p).await?;
    let mut tree = super::tree::load(tx, p).await?;
    super::projection::apply(tx, p, &mut tree, &mut members).await?;
    let represented = super::placements::represented(tx, p).await?;
    let counts = count(&mut tree, &mut members, &sites(tx, p, &represented).await?);
    for e in entities {
        let mut total = counts.unplaced.get(&e.id).map_or(0, |n| n.0);
        for w in &mut e.workplaces {
            w.headcount = counts.workplaces.get(&w.id).map_or(0, |n| n.0);
            w.regular_workers = console_entity_application::RegularWorkers::hold(w.headcount);
            total += w.headcount;
        }
        e.regular_workers = console_entity_application::RegularWorkers::hold(total);
    }
    Ok(())
}
