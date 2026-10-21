//! The one order every org-unit surface shows (the chart's): each parent
//! before its children, depth first; siblings by their stored 순서, the
//! unplaced after them by name (byte order, the SQL `COLLATE "C"`), then id.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// One unit as the tree order sees it.
#[derive(Debug, Clone, Copy)]
pub struct TreeEntry<'a> {
    pub id: Uuid,
    pub parent: Option<Uuid>,
    pub position: Option<i32>,
    pub name: &'a str,
}

/// Two siblings in the chart's order.
#[must_use]
pub fn sibling_cmp(a: &TreeEntry<'_>, b: &TreeEntry<'_>) -> Ordering {
    (a.position.is_none(), a.position, a.name, a.id).cmp(&(
        b.position.is_none(),
        b.position,
        b.name,
        b.id,
    ))
}

/// The ids of `entries` in tree order. A unit whose parent is not among them
/// is a root; a unit no root reaches (a cycle) comes last, never dropped.
#[must_use]
pub fn tree_order(entries: &[TreeEntry<'_>]) -> Vec<Uuid> {
    let known: HashSet<Uuid> = entries.iter().map(|e| e.id).collect();
    let mut sorted: Vec<&TreeEntry<'_>> = entries.iter().collect();
    sorted.sort_by(|a, b| sibling_cmp(a, b));
    let mut children: HashMap<Option<Uuid>, Vec<Uuid>> = HashMap::new();
    for e in &sorted {
        let parent = e.parent.filter(|p| known.contains(p) && *p != e.id);
        children.entry(parent).or_default().push(e.id);
    }
    let mut out = Vec::with_capacity(entries.len());
    let mut seen = HashSet::with_capacity(entries.len());
    let mut stack: Vec<Uuid> = children
        .get(&None)
        .map(|c| c.iter().rev().copied().collect())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        if seen.insert(id) {
            out.push(id);
            if let Some(kids) = children.get(&Some(id)) {
                stack.extend(kids.iter().rev());
            }
        }
    }
    out.extend(sorted.iter().map(|e| e.id).filter(|id| seen.insert(*id)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn depth_first_with_stored_order_then_name() {
        let (a, b, a1, a2, a3, b1) = (id(1), id(2), id(3), id(4), id(5), id(6));
        let e = |id, parent, position, name| TreeEntry {
            id,
            parent,
            position,
            name,
        };
        let entries = [
            e(b1, Some(b), Some(0), "b1"),
            e(a3, Some(a), None, "Z"),
            e(a2, Some(a), None, "B"),
            e(a1, Some(a), Some(0), "가"),
            e(b, None, Some(0), "나"),
            e(a, None, Some(1), "다"),
        ];
        assert_eq!(tree_order(&entries), vec![b, b1, a, a1, a2, a3]);
    }

    #[test]
    fn an_orphan_is_a_root_and_a_cycle_is_kept() {
        let (x, y, orphan) = (id(1), id(2), id(3));
        let e = |id, parent| TreeEntry {
            id,
            parent,
            position: None,
            name: "",
        };
        let got = tree_order(&[e(x, Some(y)), e(y, Some(x)), e(orphan, Some(id(9)))]);
        assert_eq!(got, vec![orphan, x, y]);
    }
}
