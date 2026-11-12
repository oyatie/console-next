//! `GET /api/v1/org-structure`: all → legal entity → workplace → department
//! (any depth), composed from the entity records and the canonical OrgUnits
//! (read only). A SITE unit that represents a workplace is drawn AS that
//! workplace, so nothing appears twice; SITE units with no placement are
//! listed as `unplaced` (a to-do).
//!
//! Counts (spec D1, D2; review R13): departments count their members
//! (`employees.org_unit_id`), workplaces and legal entities their
//! assignments today; a legal entity adds its unplaced (a legal entity but no
//! workplace), and the root's "legal entity undecided" is everyone who has
//! not left and has no legal entity today. Children follow the order
//! (`org_unit_positions`, `workplaces.sort_order`, `legal_entities.sort_order`),
//! then name or creation.

use console_entity_application::{Actor, OrgStructure, OrgStructureNode, ReadOptions, ReadPoint};
use console_orgchange_domain::{TreeEntry, sibling_cmp};
use console_platform_db::with_org_snapshot;
use uuid::Uuid;

use crate::{PgEntityError, PgEntityStore, Tx, read_phase};

impl PgEntityStore {
    /// # Errors
    /// Database faults.
    pub async fn org_structure(&self, actor: &Actor) -> Result<OrgStructure, PgEntityError> {
        self.org_structure_at(actor, ReadOptions::default()).await
    }

    /// # Errors
    /// Database faults. Historical reads keep the caller's current authorization scope.
    pub async fn org_structure_at(
        &self,
        actor: &Actor,
        q: ReadOptions,
    ) -> Result<OrgStructure, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, |tx| {
            Box::pin(async move { compose(tx, granted.as_deref(), q).await })
        })
        .await
    }
}

pub(crate) async fn compose(
    tx: &mut Tx<'_>,
    granted: Option<&[Uuid]>,
    q: ReadOptions,
) -> Result<OrgStructure, PgEntityError> {
    let point = ReadPoint::new(crate::today_kst(tx).await?, q);
    let phase = read_phase(tx, false).await?;
    let tenant_name: String = sqlx::query_scalar("SELECT name FROM organizations LIMIT 1")
        .fetch_one(tx.as_mut())
        .await?;
    let mut tree = crate::asof::tree::load(tx, point).await?;
    let mut members = crate::asof::membership::load(tx, point).await?;
    let scheduled = crate::asof::projection::apply(tx, point, &mut tree, &mut members).await?;
    let represented = crate::asof::placements::represented(tx, point).await?;
    let entities = crate::read::entities_at(tx, None, granted, false, point).await?;
    let counts = crate::asof::membership::count(
        &mut tree,
        &mut members,
        &crate::asof::membership::sites(tx, point, &represented).await?,
    );
    let changed = crate::asof::dates::changed(tx, point).await?;
    let mut nodes = Vec::new();
    for e in entities
        .iter()
        .filter(|e| !e.current.as_ref().is_some_and(|c| c.before_first_record))
    {
        let mut wp_nodes = Vec::new();
        for w in e
            .workplaces
            .iter()
            .filter(|w| !w.current.as_ref().is_some_and(|c| c.before_first_record))
        {
            let site = represented
                .get(&w.id)
                .filter(|s| tree.units.contains_key(s));
            let kids = site.map(|s| tree.kids(*s)).unwrap_or_default();
            let mut chips = Vec::new();
            if w.needs_confirmation {
                chips.push("needs_confirmation");
            }
            match w.current.as_ref().map(|c| c.status.as_str()) {
                Some("SUSPENDED") => chips.push("suspended"),
                Some("CLOSED") => chips.push("closed"),
                _ => {}
            }
            wp_nodes.push(OrgStructureNode {
                scheduled_by: None,
                changed_after: false,
                kind: "WORKPLACE",
                id: w.id,
                name: w
                    .current
                    .as_ref()
                    .map(|c| c.name.clone())
                    .unwrap_or_default(),
                version: None,
                org_unit_id: site.copied(),
                workplace_kind: w.kind_code.clone(),
                code: w.code.clone(),
                head: None,
                headcount: counts.workplaces.get(&w.id).map_or(0, |n| n.0),
                direct_headcount: site.map_or(0, |s| tree.units[s].direct),
                dispatched_headcount: counts.workplaces.get(&w.id).map_or(0, |n| n.1),
                chips,
                children: kids,
            });
        }
        let mut chips = Vec::new();
        if e.needs_confirmation {
            chips.push("needs_confirmation");
        }
        if e.registrations
            .iter()
            .any(|r| r.verification_tier == "NONE")
        {
            chips.push("unverified");
        }
        let name = e
            .current
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_default();
        let (unplaced, unplaced_dispatched) = counts.unplaced.get(&e.id).copied().unwrap_or((0, 0));
        nodes.push(OrgStructureNode {
            scheduled_by: None,
            changed_after: false,
            kind: "LEGAL_ENTITY",
            id: e.id,
            name,
            version: None,
            org_unit_id: None,
            workplace_kind: None,
            code: None,
            head: None,
            headcount: unplaced + wp_nodes.iter().map(|w| w.headcount).sum::<i64>(),
            direct_headcount: unplaced,
            dispatched_headcount: unplaced_dispatched
                + wp_nodes.iter().map(|w| w.dispatched_headcount).sum::<i64>(),
            chips,
            children: wp_nodes,
        });
    }
    let placed: std::collections::HashSet<Uuid> = represented.values().copied().collect();
    let mut roots: Vec<Uuid> = tree
        .units
        .iter()
        // Unplaced units belong to no legal entity: only a tenant-wide scope sees them.
        .filter(|(id, u)| granted.is_none() && u.parent.is_none() && !placed.contains(id))
        .map(|(id, _)| *id)
        .collect();
    // Siblings of the tenant root: the one sibling rule, as every chart level.
    let entry = |id: &Uuid| TreeEntry {
        id: *id,
        parent: None,
        position: tree.units[id].position,
        name: &tree.units[id].name,
    };
    roots.sort_by(|a, b| sibling_cmp(&entry(a), &entry(b)));
    let mut unplaced: Vec<OrgStructureNode> = roots.into_iter().map(|id| tree.node(id)).collect();
    // People with no legal entity yet ("legal entity undecided") belong to no legal entity:
    // only a tenant-wide scope sees them.
    let entity_unknown_headcount = granted.is_none().then_some(counts.unknown);
    for node in nodes.iter_mut().chain(unplaced.iter_mut()) {
        crate::asof::dates::mark(node, &scheduled, &changed);
    }
    Ok(OrgStructure {
        read: point.stamp(),
        tenant_name,
        phase: phase.as_str().into(),
        entities: nodes,
        unplaced,
        entity_unknown_headcount,
    })
}
