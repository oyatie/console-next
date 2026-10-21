//! W03: 부서 / 사업장 names a file wrote that bind nothing exactly, offered as
//! candidates (never bound): the same text after normalising whitespace,
//! full/half width and separators, then after dropping a 공장/지점-style
//! suffix, then the last segment of a path (`경영지원본부>총무팀`). The
//! operator's click (`unit_map` / `workplace_map`) is what binds.

use std::collections::BTreeMap;

use serde::Serialize;
use uuid::Uuid;

use super::cells::half_width;
use super::review::ReviewQueue;

/// Most candidates offered for one text.
const MAX_CANDIDATES: usize = 8;

const SUFFIXES: [&str; 9] = [
    "사업장",
    "사업소",
    "공장",
    "지점",
    "지사",
    "본사",
    "센터",
    "파트",
    "팀",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NameCandidate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub id: Uuid,
    pub name: String,
    /// `same_name` (the text names two or more), `normalized`, `path`, `suffix`.
    pub basis: &'static str,
}

/// The comparison key of an org name: half-width, lower case, without
/// whitespace or separators (`영업 2팀` = `영업2팀`, `ＱＡ팀` = `qa팀`).
#[must_use]
pub fn org_name_key(text: &str) -> String {
    half_width(text)
        .chars()
        .filter(|c| !c.is_whitespace() && !"-_·.,()[]/\\:'\"".contains(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

/// The key without one trailing suffix (`평택공장` → `평택`); never empty.
fn base(key: &str) -> &str {
    SUFFIXES
        .iter()
        .find_map(|s| key.strip_suffix(s).filter(|rest| !rest.is_empty()))
        .unwrap_or(key)
}

/// The last segment of a path text (`A>B`, `A › B`, `A/B`), if it is one.
fn last_segment(text: &str) -> Option<&str> {
    let (_, last) = text.rsplit_once(['>', '›', '/', '＞'])?;
    let last = last.trim();
    (!last.is_empty()).then_some(last)
}

/// The records `text` may mean, best first; empty when it names exactly one.
#[must_use]
pub fn candidates(text: &str, index: &BTreeMap<String, Vec<Uuid>>) -> Vec<NameCandidate> {
    let mut out: Vec<NameCandidate> = Vec::new();
    let mut push = |id: Uuid, name: &str, basis: &'static str| {
        if !out.iter().any(|c| c.id == id) {
            out.push(NameCandidate {
                alias: None,
                id,
                name: name.to_owned(),
                basis,
            });
        }
    };
    match index.get(text) {
        Some(ids) if ids.len() == 1 => return Vec::new(),
        Some(ids) => ids.iter().for_each(|id| push(*id, text, "same_name")),
        None => {}
    }
    let key = org_name_key(text);
    let path = last_segment(text).map(org_name_key);
    let hit = |basis: &str, k: &str| match basis {
        "normalized" => k == key,
        "path" => path
            .as_deref()
            .is_some_and(|p| k == p || base(k) == base(p)),
        _ => base(k) == base(&key),
    };
    for basis in ["normalized", "path", "suffix"] {
        for (name, ids) in index {
            if hit(basis, &org_name_key(name)) {
                ids.iter().for_each(|id| push(*id, name, basis));
            }
        }
    }
    out.truncate(MAX_CANDIDATES);
    out
}

/// Fills every unit / 사업장 item of `queue` with its candidates; their ids
/// become the item's choices (one click binds).
pub fn with_candidates(
    queue: &mut ReviewQueue,
    units: &BTreeMap<String, Vec<Uuid>>,
    workplaces: &BTreeMap<String, Vec<Uuid>>,
) {
    for item in &mut queue.items {
        let (Some(text), Some(res)) = (item.value.as_deref(), item.resolution.as_mut()) else {
            continue;
        };
        let index = match res.decision {
            "unit_map" => units,
            "workplace_map" => workplaces,
            _ => continue,
        };
        item.candidates = candidates(text, index);
        res.choices = item.candidates.iter().map(|c| c.id.to_string()).collect();
    }
}

#[cfg(test)]
#[path = "names_tests.rs"]
mod tests;
