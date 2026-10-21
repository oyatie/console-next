//! Dated org-unit tree loader and recursive chart nodes.
use crate::{PgEntityError, Tx};
use console_entity_application::{OrgStructureNode, OrgUnitHeadRef, ReadPoint};
use console_orgchange_domain::{TreeEntry, sibling_cmp};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;
pub(crate) struct Unit {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) parent: Option<Uuid>,
    pub(crate) version: i64,
    pub(crate) position: Option<i32>,
    pub(crate) code: Option<String>,
    pub(crate) head: Option<OrgUnitHeadRef>,
    pub(crate) direct: i64,
    pub(crate) dispatched: i64,
}

pub(crate) struct Tree {
    pub(crate) units: HashMap<Uuid, Unit>,
    pub(crate) children: HashMap<Uuid, Vec<Uuid>>,
}

impl Tree {
    pub(crate) fn node(&self, id: Uuid) -> OrgStructureNode {
        let unit = &self.units[&id];
        let kids = self.kids(id);
        OrgStructureNode {
            scheduled_by: None,
            changed_after: false,
            // One 부서 kind (decisions #18); a pre-0262 `team` reads as a 부서.
            kind: if unit.kind == "site" {
                "SITE"
            } else {
                "DEPARTMENT"
            },
            id,
            name: unit.name.clone(),
            version: Some(unit.version),
            org_unit_id: None,
            workplace_kind: None,
            code: unit.code.clone(),
            head: unit.head.clone(),
            headcount: unit.direct + kids.iter().map(|k| k.headcount).sum::<i64>(),
            direct_headcount: unit.direct,
            dispatched_headcount: unit.dispatched
                + kids.iter().map(|k| k.dispatched_headcount).sum::<i64>(),
            chips: Vec::new(),
            children: kids,
        }
    }

    pub(crate) fn kids(&self, id: Uuid) -> Vec<OrgStructureNode> {
        self.children
            .get(&id)
            .map(|c| c.iter().map(|k| self.node(*k)).collect())
            .unwrap_or_default()
    }
}

/// Every live unit with its counts, 순서, code and dated head (D19).
pub(crate) async fn load(tx: &mut Tx<'_>, point: ReadPoint) -> Result<Tree, PgEntityError> {
    let rows = sqlx::query(
        "SELECT DISTINCT ON (r.org_unit_id) r.org_unit_id, r.version, r.attributes, p.position \
         FROM org_unit_revisions r LEFT JOIN org_unit_positions p ON p.org_unit_id = r.org_unit_id \
         WHERE COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date) <= $1 \
           AND r.created_at <= COALESCE($2::timestamptz, now()) \
         ORDER BY r.org_unit_id, COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date) DESC, r.version DESC"
    )
    .bind(point.as_of)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let mut units = HashMap::new();
    for r in &rows {
        let attrs: serde_json::Value = r.try_get("attributes")?;
        // A unit with no kind is a legacy 지역/지점 binding anchor, not a
        // tree node (decisions #18; orgchange `head.rs` reads it the same way).
        if attrs["status"] == "dissolved"
            || !matches!(attrs["kind"].as_str(), Some("site" | "department" | "team"))
        {
            continue;
        }
        let text = |k: &str| attrs[k].as_str().map(str::to_owned);
        let head = text("head_employee_id")
            .and_then(|h| Uuid::parse_str(&h).ok())
            .map(|employee_id| OrgUnitHeadRef {
                employee_id,
                name: None,
                since: text("head_since").and_then(|d| {
                    time::Date::parse(&d, &time::format_description::well_known::Iso8601::DATE).ok()
                }),
                concurrent: false,
            });
        units.insert(
            r.try_get::<Uuid, _>("org_unit_id")?,
            Unit {
                name: text("name").unwrap_or_default(),
                kind: text("kind").unwrap_or_default(),
                parent: text("parent_id").and_then(|p| Uuid::parse_str(&p).ok()),
                version: r.try_get("version")?,
                position: r.try_get("position")?,
                code: text("code"),
                head,
                direct: 0,
                dispatched: 0,
            },
        );
    }
    // Head names, and 「(겸)」: the head belongs elsewhere or heads another unit too.
    let heads: Vec<Uuid> = units
        .values()
        .filter_map(|u| u.head.as_ref().map(|h| h.employee_id))
        .collect();
    let people: HashMap<Uuid, (String, Option<Uuid>)> =
        sqlx::query("SELECT id, name, org_unit_id FROM employees WHERE id = ANY($1)")
            .bind(&heads)
            .fetch_all(tx.as_mut())
            .await?
            .iter()
            .map(|r| {
                Ok((
                    r.try_get("id")?,
                    (r.try_get("name")?, r.try_get("org_unit_id")?),
                ))
            })
            .collect::<Result<_, sqlx::Error>>()?;
    for (id, unit) in &mut units {
        if let Some(head) = unit.head.as_mut() {
            let person = people.get(&head.employee_id);
            head.name = person.map(|p| p.0.clone());
            head.concurrent = person.is_some_and(|p| p.1 != Some(*id))
                || heads.iter().filter(|h| **h == head.employee_id).count() > 1;
        }
    }
    let mut children: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (id, unit) in &units {
        if let Some(parent) = unit.parent.filter(|p| units.contains_key(p)) {
            children.entry(parent).or_default().push(*id);
        }
    }
    for list in children.values_mut() {
        let entry = |id: &Uuid| TreeEntry {
            id: *id,
            parent: units[id].parent,
            position: units[id].position,
            name: &units[id].name,
        };
        list.sort_by(|a, b| sibling_cmp(&entry(a), &entry(b)));
    }
    Ok(Tree { units, children })
}
