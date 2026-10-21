//! Date range validation and pure comparison of scoped chart snapshots.
use crate::{AsOfQuery, OrgStructure, OrgStructureNode, ReadOptions, ScheduledBy};
use console_entity_domain::{Issues, Refusal};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::Date;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CompareQuery {
    pub a: String,
    pub b: String,
    pub known_at: Option<String>,
}
impl CompareQuery {
    /// # Errors
    /// Malformed dates and reversed ranges.
    pub fn parse(&self) -> Result<(Date, Date, ReadOptions), Refusal> {
        let mut issues = Issues::default();
        let a = issues.date("a", Some(&self.a), true, None);
        let b = issues.date("b", Some(&self.b), true, None);
        if a.zip(b).is_some_and(|(a, b)| a > b) {
            issues.push("b", "date_invalid");
        }
        let (a, b) = issues.finish(|| (a, b))?;
        let options = AsOfQuery {
            as_of: None,
            known_at: self.known_at.clone(),
        }
        .parse()?;
        a.zip(b)
            .map(|(a, b)| (a, b, options))
            .ok_or_else(|| Refusal::field("a", "date_invalid"))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeDiff {
    pub id: Uuid,
    pub name: String,
    pub before_name: Option<String>,
    pub marks: Vec<&'static str>,
    pub changes: Vec<ScheduledBy>,
}
#[derive(Debug, Serialize)]
pub struct StructureDiff {
    pub a: String,
    pub b: String,
    pub structure: OrgStructure,
    pub marks: Vec<NodeDiff>,
    pub changes: Vec<ScheduledBy>,
}

pub fn nodes(s: &OrgStructure) -> BTreeMap<Uuid, (&OrgStructureNode, Option<Uuid>)> {
    fn walk<'a>(
        ns: &'a [OrgStructureNode],
        parent: Option<Uuid>,
        out: &mut BTreeMap<Uuid, (&'a OrgStructureNode, Option<Uuid>)>,
    ) {
        for n in ns {
            out.insert(n.id, (n, parent));
            walk(&n.children, Some(n.id), out);
        }
    }
    let mut out = BTreeMap::new();
    walk(&s.entities, None, &mut out);
    walk(&s.unplaced, None, &mut out);
    out
}

#[must_use]
pub fn compare(a: &OrgStructure, b: &OrgStructure) -> Vec<NodeDiff> {
    let (before, after) = (nodes(a), nodes(b));
    let ids: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).copied().collect();
    ids.into_iter()
        .filter_map(|id| {
            let (old, new) = (before.get(&id), after.get(&id));
            let mut marks = Vec::new();
            match (old, new) {
                (None, Some(_)) => marks.push("new"),
                (Some(_), None) => marks.push("gone"),
                (Some((a, pa)), Some((b, pb))) => {
                    if pa != pb {
                        marks.push("moved");
                    }
                    if a.name != b.name {
                        marks.push("renamed");
                    }
                }
                _ => {}
            }
            let n = new.or(old)?.0;
            (!marks.is_empty()).then(|| NodeDiff {
                id,
                name: n.name.clone(),
                before_name: old.map(|(n, _)| n.name.clone()),
                marks,
                changes: Vec::new(),
            })
        })
        .collect()
}

/// Retain removed branches as zero-count ghosts in the comparison chart.
#[must_use]
pub fn with_gone(before: &OrgStructure, mut after: OrgStructure) -> OrgStructure {
    let present: std::collections::BTreeSet<_> = nodes(&after).keys().copied().collect();
    fn find(nodes: &mut [OrgStructureNode], id: Uuid) -> Option<&mut OrgStructureNode> {
        for node in nodes {
            if node.id == id {
                return Some(node);
            }
            if let Some(n) = find(&mut node.children, id) {
                return Some(n);
            }
        }
        None
    }
    fn append(
        old: &[OrgStructureNode],
        parent: Option<Uuid>,
        new: &mut Vec<OrgStructureNode>,
        other: &mut Vec<OrgStructureNode>,
        present: &std::collections::BTreeSet<Uuid>,
    ) {
        for n in old {
            if !present.contains(&n.id) {
                let mut ghost = n.clone();
                ghost.headcount = 0;
                ghost.direct_headcount = 0;
                ghost.dispatched_headcount = 0;
                ghost.children.clear();
                if let Some(parent) = parent.and_then(|p| find(new, p).or_else(|| find(other, p))) {
                    parent.children.push(ghost);
                } else {
                    new.push(ghost);
                }
            }
            append(&n.children, Some(n.id), new, other, present);
        }
    }
    append(
        &before.entities,
        None,
        &mut after.entities,
        &mut after.unplaced,
        &present,
    );
    append(
        &before.unplaced,
        None,
        &mut after.unplaced,
        &mut after.entities,
        &present,
    );
    after.read.read_only = true;
    after
}

#[cfg(test)]
#[path = "compare_tests.rs"]
mod tests;
