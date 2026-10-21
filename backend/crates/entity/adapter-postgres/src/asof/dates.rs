//! Scope-neutral metadata is attached only to nodes surviving scoped composition.
use crate::{PgEntityError, Tx};
use console_entity_application::{OrgStructureNode, ReadPoint, ScheduledBy};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) async fn changed(tx: &mut Tx<'_>, p: ReadPoint) -> Result<HashSet<Uuid>, PgEntityError> {
    if p.as_of >= p.today {
        return Ok(HashSet::new());
    }
    Ok(sqlx::query_scalar::<_, Uuid>(
        "SELECT legal_entity_id FROM legal_entity_revisions WHERE effective_from > $1 AND effective_from <= $2 \
             AND created_at <= COALESCE($3::timestamptz,now()) \
         UNION SELECT workplace_id FROM workplace_revisions WHERE effective_from > $1 AND effective_from <= $2 \
             AND created_at <= COALESCE($3::timestamptz,now()) \
         UNION SELECT org_unit_id FROM org_unit_revisions WHERE entity_try_iso_date(attributes->>'effective_from') > $1 \
             AND entity_try_iso_date(attributes->>'effective_from') <= $2 AND created_at <= COALESCE($3::timestamptz,now())",
    ).bind(p.as_of).bind(p.today).bind(p.known_at).fetch_all(tx.as_mut()).await?.into_iter().collect())
}

pub(crate) fn mark(
    n: &mut OrgStructureNode,
    scheduled: &HashMap<Uuid, ScheduledBy>,
    changed: &HashSet<Uuid>,
) {
    let id = n.org_unit_id.unwrap_or(n.id);
    n.scheduled_by = scheduled.get(&id).cloned();
    n.changed_after = changed.contains(&n.id) || changed.contains(&id);
    for c in &mut n.children {
        mark(c, scheduled, changed);
    }
}
