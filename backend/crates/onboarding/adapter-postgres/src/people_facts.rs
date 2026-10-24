//! Placement counts share the roster's current-assignment and unresolved-unit predicates.
use crate::PgOnboardingError;
use console_onboarding_domain::{Breakdown, Record, Records};
use sqlx::{Postgres, Row, Transaction};

macro_rules! current { () => { "WITH RECURSIVE today AS (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS d), \
 people AS (SELECT e.id, e.name, e.org_unit_id, e.source_metadata, a.legal_entity_id, a.workplace_id \
 FROM person_employees_current e LEFT JOIN employment_assignments a ON a.employee_id = e.id AND a.org_id = e.org_id \
 AND a.superseded_at IS NULL AND a.valid_from <= (SELECT d FROM today) \
 AND (a.valid_to IS NULL OR a.valid_to > (SELECT d FROM today)) \
 WHERE entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AND e.merged_into_employee_id IS NULL) " }; }

pub(crate) async fn records(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Records, PgOnboardingError> {
    let sql = concat!(
        current!(),
        " SELECT id::text, name, legal_entity_id::text AS entity, \
        workplace_id IS NULL OR (org_unit_id IS NULL AND source_metadata ? 'unresolved_org_unit') AS unplaced \
        FROM people WHERE legal_entity_id IS NULL OR workplace_id IS NULL \
        OR (org_unit_id IS NULL AND source_metadata ? 'unresolved_org_unit') ORDER BY name, id"
    );
    let rows = sqlx::query(sql).fetch_all(tx.as_mut()).await?;
    let mut out = Records::new();
    for r in rows {
        let entity: Option<String> = r.try_get("entity")?;
        let unknown = entity.is_none();
        let record = Record {
            kind: "employee".into(),
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            legal_entity_id: entity.unwrap_or_else(|| uuid::Uuid::nil().to_string()),
        };
        if r.try_get::<bool, _>("unplaced")? {
            out.entry("unplaced_people".into())
                .or_default()
                .push(record.clone());
        }
        if unknown {
            out.entry("entity_unknown_people".into())
                .or_default()
                .push(record);
        }
    }
    Ok(out)
}

pub(crate) async fn breakdown(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<Breakdown>, PgOnboardingError> {
    let sql = concat!(
        current!(),
        ", heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
         FROM org_unit_revisions ORDER BY org_unit_id, version DESC), \
        up AS (SELECT h.org_unit_id AS unit, h.org_unit_id, h.attributes, 0 AS depth FROM heads h \
          WHERE h.attributes->>'kind' IN ('department', 'team') \
            AND h.attributes->>'status' IS DISTINCT FROM 'dissolved' \
          UNION ALL SELECT u.unit, h.org_unit_id, h.attributes, u.depth + 1 FROM heads h JOIN up u \
            ON h.org_unit_id::text = u.attributes->>'parent_id' \
          WHERE u.depth < 64 AND h.attributes->>'status' IS DISTINCT FROM 'dissolved'), \
        units AS (SELECT DISTINCT ON (u.unit) u.unit, p.legal_entity_id, p.workplace_id \
          FROM up u JOIN org_unit_placements p ON p.org_unit_id = u.org_unit_id \
          WHERE p.valid_from <= (SELECT d FROM today) \
            AND (p.valid_to IS NULL OR p.valid_to > (SELECT d FROM today)) ORDER BY u.unit, u.depth), nodes AS ( \
        SELECT 'legal_entity' AS kind, e.id, e.id AS entity, e.sort_order AS e_order, e.created_at AS e_created, \
          NULL::int AS w_order, NULL::timestamptz AS w_created, \
          COALESCE((SELECT name FROM legal_entity_revisions r WHERE r.legal_entity_id = e.id ORDER BY version DESC LIMIT 1), '') AS name, \
          (SELECT count(*) FROM people WHERE legal_entity_id = e.id) AS people, \
          (SELECT count(*) FROM units WHERE legal_entity_id = e.id) AS units \
          FROM legal_entities e WHERE voided_at IS NULL AND closed_on IS NULL \
        UNION ALL SELECT 'workplace', w.id, w.legal_entity_id, le.sort_order, le.created_at, w.sort_order, w.created_at, \
          COALESCE((SELECT name FROM workplace_revisions r WHERE r.workplace_id = w.id ORDER BY version DESC LIMIT 1), ''), \
          (SELECT count(*) FROM people WHERE workplace_id = w.id), (SELECT count(*) FROM units WHERE workplace_id = w.id) \
          FROM workplaces w LEFT JOIN legal_entities le ON le.id = w.legal_entity_id \
          WHERE w.voided_at IS NULL AND w.closed_on IS NULL) \
        SELECT kind, id::text, entity::text, name, people, units FROM nodes \
        ORDER BY e_order NULLS LAST, e_created, entity, kind, w_order NULLS LAST, w_created, id"
    );
    sqlx::query(sql)
        .fetch_all(tx.as_mut())
        .await?
        .iter()
        .map(|r| {
            Ok(Breakdown {
                kind: r.try_get("kind")?,
                id: r.try_get("id")?,
                name: r.try_get("name")?,
                legal_entity_id: r.try_get("entity")?,
                people: r.try_get("people")?,
                units: r.try_get("units")?,
            })
        })
        .collect()
}
