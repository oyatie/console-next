//! A 사업장's own org-tree unit (decisions #14.1): the SITE unit that
//! `represents_workplace` is created together with the 사업장, so people can
//! be registered there with no 부서, and is dissolved when the 사업장 (or its
//! 법인) is voided during setup. Writes go through the canonical OrgUnit
//! owner ([`OrgUnitSetupWritePort`]); the client never creates SITE units
//! (design §3.7).

use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::command_id;
use crate::org_units::{OrgUnitSetupWritePort, port_refusal};
use crate::{Admitted, PgEntityError, Tx};
use console_entity_application::Actor;
use console_entity_domain::Refusal;

/// The SITE unit that represents `workplace`, created (and placed) if none.
pub(crate) async fn workplace_unit(
    tx: &mut Tx<'_>,
    actor: &Actor,
    workplace: Uuid,
    today: time::Date,
    admitted: Admitted,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<Uuid, PgEntityError> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT org_unit_id FROM org_unit_placements WHERE workplace_id = $1 AND represents_workplace AND valid_to IS NULL",
    )
    .bind(workplace)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let row = sqlx::query(
        "SELECT w.legal_entity_id, r.name FROM workplaces w JOIN LATERAL (SELECT name FROM workplace_revisions x \
           WHERE x.workplace_id = w.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true \
         WHERE w.id = $1 AND w.voided_at IS NULL AND w.closed_on IS NULL",
    )
    .bind(workplace)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::field("workplace_id", "workplace_not_found"))?;
    let entity: Uuid = row.try_get("legal_entity_id")?;
    let name: String = row.try_get("name")?;
    let attributes = json!({ "name": name.chars().take(120).collect::<String>(), "kind": "site", "status": "active", "effective_from": today.to_string() });
    let site = port
        .write(tx, actor.org, actor.user, Uuid::new_v4(), None, attributes)
        .await
        .map_err(port_refusal)?;
    sqlx::query(
        "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, represents_workplace, \
           valid_from, change_mode, actor_id, command_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, true, $4, $5, $6, $7)",
    )
    .bind(site)
    .bind(entity)
    .bind(workplace)
    .bind(today)
    .bind(admitted.mode.as_str())
    .bind(*actor.user.as_uuid())
    .bind(command_id(actor)?)
    .execute(tx.as_mut())
    .await?;
    Ok(site)
}

/// The open SITE placements of the 사업장 `id` (`column = "workplace_id"`) or
/// of every 사업장 of the 법인 `id` (`column = "legal_entity_id"`).
/// `$1` is that id, `$2` whether it names a 법인.
macro_rules! sites {
    () => {
        "WITH sites AS (SELECT p.id, p.org_unit_id FROM org_unit_placements p \
         WHERE p.valid_to IS NULL AND p.represents_workplace AND (p.workplace_id = $1 OR p.legal_entity_id = $1 AND $2)) "
    };
}

/// The SITE units of the 사업장 `id` (or of every 사업장 of the 법인 `id`).
async fn site_units(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<Vec<Uuid>, PgEntityError> {
    Ok(
        sqlx::query_scalar(concat!(sites!(), "SELECT org_unit_id FROM sites"))
            .bind(id)
            .bind(column == "legal_entity_id")
            .fetch_all(tx.as_mut())
            .await?,
    )
}

/// Refuse a void while people are placed in the record (or, for an entity,
/// any of its 사업장): an open placement there, or anyone who has not left
/// in the 사업장's own unit or any 부서 under it. Empty 부서 do not block:
/// they are dissolved with the 사업장 (MR-12; before, a void here was a dead
/// end, since setup had no way to remove a 부서).
pub(crate) async fn ensure_unused(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<(), PgEntityError> {
    let whole_entity = column == "legal_entity_id";
    let sites = site_units(tx, column, id).await?;
    let units = crate::org_tree::subtree(tx, &sites).await?;
    let (people, placements): (i64, i64) = sqlx::query_as(
        "SELECT \
           (SELECT count(*) FROM ( \
              SELECT a.employee_id FROM employment_assignments a WHERE a.superseded_at IS NULL \
                AND (a.workplace_id = $1 OR $2 AND (a.legal_entity_id = $1 \
                     OR a.workplace_id IN (SELECT w.id FROM workplaces w WHERE w.legal_entity_id = $1))) \
              UNION SELECT e.id FROM employees e \
               WHERE e.org_unit_id = ANY($3) AND entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status)) x), \
           (SELECT count(*) FROM org_unit_placements p WHERE p.valid_to IS NULL AND NOT p.represents_workplace \
              AND (p.workplace_id = $1 OR $2 AND (p.legal_entity_id = $1 \
                   OR p.workplace_id IN (SELECT w.id FROM workplaces w WHERE w.legal_entity_id = $1))))",
    )
    .bind(id)
    .bind(whole_entity)
    .bind(&units)
    .fetch_one(tx.as_mut())
    .await?;
    if people > 0 || placements > 0 {
        return Err(Refusal::conflict(
            "record_in_use",
            format!("{people} people and {placements} org units still point at this record"),
        )
        .with_remedy("reassign_people_first")
        .into());
    }
    Ok(())
}

/// Dissolve the SITE units of a voided 사업장 (or of every 사업장 of a voided
/// 법인), and the empty 부서 under them, deepest first, and close the SITE
/// placements. Call after [`ensure_unused`], in the void's transaction. A
/// placement opened today closes tomorrow: the period CHECK forbids an empty
/// range, and the unit is dissolved either way.
pub(crate) async fn dissolve_sites(
    tx: &mut Tx<'_>,
    actor: &Actor,
    column: &'static str,
    id: Uuid,
    today: time::Date,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(), PgEntityError> {
    let sites = site_units(tx, column, id).await?;
    for unit in crate::org_tree::subtree(tx, &sites).await? {
        let Some(head) = crate::org_tree::head(tx, unit).await? else {
            continue;
        };
        let mut attributes = head.attributes;
        attributes["status"] = json!("dissolved");
        attributes["effective_from"] = json!(today.to_string());
        port.write(
            tx,
            actor.org,
            actor.user,
            Uuid::new_v4(),
            Some(unit),
            attributes,
        )
        .await
        .map_err(port_refusal)?;
    }
    sqlx::query(concat!(
        sites!(),
        "UPDATE org_unit_placements p SET valid_to = GREATEST($3, p.valid_from + 1) FROM sites s WHERE p.id = s.id"
    ))
    .bind(id)
    .bind(column == "legal_entity_id")
    .bind(today)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Keep a 사업장's SITE unit named after it: people placed 「부서 없이」 see
/// the unit's name in the org-unit list and the directory. Called when a
/// revision renames the 사업장 and takes effect today or earlier.
///
/// a future-dated rename leaves the unit until the next revise;
/// the scheduled-revision runner should call this on its effective date.
pub(crate) async fn rename_site(
    tx: &mut Tx<'_>,
    actor: &Actor,
    workplace: Uuid,
    name: &str,
    today: time::Date,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(), PgEntityError> {
    let row = sqlx::query(
        "SELECT p.org_unit_id, (SELECT attributes FROM org_unit_revisions r WHERE r.org_unit_id = p.org_unit_id \
                                ORDER BY r.version DESC LIMIT 1) AS attributes \
         FROM org_unit_placements p WHERE p.workplace_id = $1 AND p.represents_workplace AND p.valid_to IS NULL",
    )
    .bind(workplace)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(()) };
    let mut attributes: serde_json::Value = row.try_get("attributes")?;
    let name: String = name.chars().take(120).collect();
    if attributes["name"] == name.as_str() || attributes["status"] == "dissolved" {
        return Ok(());
    }
    attributes["name"] = json!(name);
    attributes["effective_from"] = json!(today.to_string());
    port.write(
        tx,
        actor.org,
        actor.user,
        Uuid::new_v4(),
        Some(row.try_get("org_unit_id")?),
        attributes,
    )
    .await
    .map_err(port_refusal)?;
    Ok(())
}
