//! Event-date scope uses the same approved hierarchy fold as the chart.
use crate::{PgEntityError, Tx};
use console_entity_application::{ReadOptions, ReadPoint};
use console_orgchange_domain::projection::{project_units, projected_unit_id};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use time::Date;
use uuid::Uuid;

pub(super) type Visibility = HashMap<Uuid, Vec<(Date, Date)>>;

// A leaving boundary changes the visible tree even though membership ends there.
pub(super) fn at(visible: &Visibility, id: &Uuid, date: Date) -> bool {
    visible.get(id).is_some_and(|windows| {
        windows
            .iter()
            .any(|(from, to)| *from <= date && date <= *to)
    })
}
fn window(visible: &mut Visibility, id: Uuid, from: Date, to: Date) {
    let windows = visible.entry(id).or_default();
    if let Some(previous) = windows.last_mut().filter(|p| p.1 >= from) {
        previous.1 = previous.1.max(to);
    } else {
        windows.push((from, to));
    }
}

pub(super) async fn visible(
    tx: &mut Tx<'_>,
    granted: Option<&[Uuid]>,
    from: Date,
    to: Date,
    q: ReadOptions,
) -> Result<Visibility, PgEntityError> {
    let sites: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT h.id,h.legal_entity_id FROM (SELECT (jsonb_populate_record(NULL::workplaces,entity_known_row(to_jsonb(w),$1))).* FROM workplaces w) h WHERE h.id IS NOT NULL",
    ).bind(q.known_at).fetch_all(tx.as_mut()).await?;
    let entities: Vec<Uuid> = sqlx::query_scalar(
        "SELECT h.id FROM (SELECT (jsonb_populate_record(NULL::legal_entities,entity_known_row(to_jsonb(e),$1))).* FROM legal_entities e) h WHERE h.id IS NOT NULL",
    ).bind(q.known_at).fetch_all(tx.as_mut()).await?;
    let allowed = |id: &Uuid| granted.is_none_or(|ids| ids.contains(id));
    let allowed_sites: HashSet<_> = sites
        .iter()
        .filter(|(id, entity)| allowed(id) || allowed(entity))
        .map(|(id, _)| *id)
        .collect();
    let mut visible = Visibility::new();
    for id in entities.into_iter().filter(|id| allowed(id)).chain(
        sites
            .iter()
            .filter(|(id, _)| allowed_sites.contains(id))
            .flat_map(|(id, e)| [*id, *e]),
    ) {
        window(&mut visible, id, from, to);
    }
    let point = ReadPoint::new(
        crate::today_kst(tx).await?,
        ReadOptions {
            as_of: Some(to),
            ..q
        },
    );
    let changes = super::projection::load(tx, point).await?;
    if granted.is_none() {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM org_units WHERE created_at <= COALESCE($1::timestamptz,now())",
        )
        .bind(q.known_at)
        .fetch_all(tx.as_mut())
        .await?;
        for id in ids {
            window(&mut visible, id, from, to);
        }
        for (change, ops) in &changes {
            for (index, op) in ops.iter().enumerate() {
                if matches!(
                    op,
                    console_orgchange_domain::OrgProposalOp::CreateOrgUnit { .. }
                ) {
                    window(&mut visible, projected_unit_id(change.id, index), from, to);
                }
            }
        }
        return Ok(visible);
    }
    let revisions: Vec<(Uuid, Date, Value)> = sqlx::query_as(
        "SELECT org_unit_id,effective,attributes FROM (SELECT DISTINCT ON (org_unit_id,effective) org_unit_id,attributes, \
         COALESCE(entity_try_iso_date(attributes->>'effective_from'),(created_at AT TIME ZONE 'Asia/Seoul')::date) AS effective \
         FROM org_unit_revisions WHERE created_at <= COALESCE($2::timestamptz,now()) \
         ORDER BY org_unit_id,effective,version DESC) r WHERE effective <= $1 ORDER BY effective,org_unit_id",
    ).bind(to).bind(q.known_at).fetch_all(tx.as_mut()).await?;
    let placements: Vec<(Uuid, Uuid, Date, Option<Date>)> = sqlx::query_as(
        "SELECT org_unit_id,workplace_id,valid_from,CASE WHEN valid_to_recorded_at > $2 THEN NULL ELSE valid_to END \
         FROM org_unit_placements WHERE represents_workplace AND valid_from <= $1 \
           AND created_at <= COALESCE($2::timestamptz,now()) ORDER BY valid_from DESC,created_at DESC,id DESC",
    ).bind(to).bind(q.known_at).fetch_all(tx.as_mut()).await?;
    let initial = from.previous_day().unwrap_or(from);
    let boundaries: Vec<_> = [initial, from, to]
        .into_iter()
        .chain(revisions.iter().map(|(_, d, _)| *d))
        .chain(
            placements
                .iter()
                .flat_map(|(_, _, start, end)| [Some(*start), *end].into_iter().flatten()),
        )
        .chain(changes.iter().map(|(c, _)| c.effective_date))
        .filter(|date| initial <= *date && *date <= to)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut native = BTreeMap::new();
    let mut revision = revisions.iter().peekable();
    for (index, date) in boundaries.iter().copied().enumerate() {
        while revision
            .peek()
            .is_some_and(|(_, effective, _)| *effective <= date)
        {
            if let Some((id, _, attrs)) = revision.next() {
                native.insert(*id, attrs.clone());
            }
        }
        let mut units: BTreeMap<_, _> = native
            .iter()
            .filter(|(_, attrs)| {
                attrs["status"] != "dissolved"
                    && matches!(attrs["kind"].as_str(), Some("site" | "department" | "team"))
            })
            .map(|(id, attrs)| (*id, attrs.clone()))
            .collect();
        let n = changes.partition_point(|(c, _)| c.effective_date <= date);
        let _ = project_units(&mut units, &changes[..n]);
        units.retain(|_, attrs| attrs["status"] != "dissolved");
        let mut represented = HashMap::new();
        for (unit, wp, start, end) in &placements {
            if *start <= date && end.is_none_or(|end| date < end) && units.contains_key(unit) {
                represented.entry(*wp).or_insert(*unit);
            }
        }
        let roots: HashSet<_> = represented
            .iter()
            .filter(|(wp, _)| allowed_sites.contains(wp))
            .map(|(_, unit)| *unit)
            .collect();
        let end = boundaries.get(index + 1).copied().unwrap_or(to);
        for id in units.keys() {
            let mut cursor = Some(*id);
            let mut visited = HashSet::new();
            while let Some(ancestor) = cursor.filter(|id| visited.insert(*id)) {
                if roots.contains(&ancestor) {
                    window(&mut visible, *id, date.max(from), end);
                    break;
                }
                cursor = units
                    .get(&ancestor)
                    .and_then(|a| a["parent_id"].as_str())
                    .and_then(|s| Uuid::parse_str(s).ok());
            }
        }
    }
    Ok(visible)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;
    #[test]
    fn timeline_visibility_includes_the_leaving_boundary_and_excludes_later_events() {
        let id = Uuid::nil();
        let visible =
            Visibility::from([(id, vec![(date!(2026 - 03 - 01), date!(2026 - 03 - 05))])]);
        assert!(!at(&visible, &id, date!(2026 - 02 - 28)));
        assert!(at(&visible, &id, date!(2026 - 03 - 01)));
        assert!(at(&visible, &id, date!(2026 - 03 - 05)));
        assert!(!at(&visible, &id, date!(2026 - 03 - 06)));
        assert!(!at(&visible, &Uuid::new_v4(), date!(2026 - 03 - 01)));
    }
}
