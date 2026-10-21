//! Reads of a bulk 법인 · 사업장 op (MR-29): the record's state for the
//! diff, its newest revision, and the record a CREATE row would duplicate.

use console_entity_domain::Refusal;
use console_entity_domain::legal_entity::{LegalEntityInput, validate_legal_entity};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::entity_batch_ops::OpErr;
use crate::{PgEntityError, Tx};

/// Far enough ahead that a 사업장 view shows its latest revision as current.
const LATEST: time::Date = time::Date::MAX;

/// A view state as a map for the diff, minus revision bookkeeping, plus `extra`.
pub(crate) fn state<S: serde::Serialize, const N: usize>(
    s: Option<&S>,
    extra: [(&str, Value); N],
) -> Map<String, Value> {
    let mut map = match s.map(serde_json::to_value) {
        Some(Ok(Value::Object(map))) => map,
        _ => Map::new(),
    };
    for key in [
        "version",
        "effective_from",
        "before_first_record",
        "change_mode",
    ] {
        map.remove(key);
    }
    for (k, v) in extra {
        map.insert(k.to_owned(), v);
    }
    map
}

/// `needs_confirmation` and the latest state (with its 대표 / 본점 flags).
pub(crate) async fn workplace_state(
    tx: &mut Tx<'_>,
    entity: Uuid,
    id: Uuid,
) -> Result<(bool, Map<String, Value>), OpErr> {
    let mut all = crate::workplace::views(tx, &[entity], None, LATEST, true).await?;
    let view = all
        .remove(&entity)
        .and_then(|list| list.into_iter().find(|w| w.id == id))
        .ok_or_else(|| Refusal::not_found("workplace_not_found"))?;
    let flags = [
        ("is_primary", json!(view.is_primary)),
        ("is_head_office", json!(view.is_head_office)),
    ];
    Ok((view.needs_confirmation, state(view.current.as_ref(), flags)))
}

/// The record's newest version and that revision's id.
pub(crate) async fn head(
    tx: &mut Tx<'_>,
    kind: &str,
    id: Uuid,
) -> Result<(i32, Uuid), PgEntityError> {
    let sql = if kind == "legal_entity" {
        "SELECT version, id FROM legal_entity_revisions WHERE legal_entity_id = $1 ORDER BY version DESC LIMIT 1"
    } else {
        "SELECT version, id FROM workplace_revisions WHERE workplace_id = $1 ORDER BY version DESC LIMIT 1"
    };
    Ok(sqlx::query_as(sql).bind(id).fetch_one(tx.as_mut()).await?)
}

/// An open 법인 the row would duplicate: same 법인등록번호, else same 상호.
pub(crate) async fn existing_entity(
    tx: &mut Tx<'_>,
    input: &LegalEntityInput,
    today: time::Date,
) -> Result<Option<Uuid>, OpErr> {
    // An invalid row is refused by the writer with every field issue.
    let Ok((draft, _)) = validate_legal_entity(input, today) else {
        return Ok(None);
    };
    Ok(sqlx::query_scalar(
        "SELECT h.id FROM legal_entities h WHERE h.voided_at IS NULL AND h.closed_on IS NULL AND ( \
           ($1::text IS NOT NULL AND h.crn = $1) OR ($1::text IS NULL AND EXISTS (SELECT 1 FROM ( \
             SELECT name FROM legal_entity_revisions r WHERE r.legal_entity_id = h.id \
             ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) n WHERE n.name = $2))) \
         ORDER BY h.created_at LIMIT 1",
    )
    .bind(draft.crn.as_ref().map(|c| c.as_str().to_owned()))
    .bind(&draft.name)
    .fetch_optional(tx.as_mut())
    .await?)
}

/// An open 사업장 of `entity` with the same name.
pub(crate) async fn existing_workplace(
    tx: &mut Tx<'_>,
    entity: Uuid,
    name: Option<&str>,
) -> Result<Option<Uuid>, OpErr> {
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    Ok(sqlx::query_scalar(
        "SELECT w.id FROM workplaces w WHERE w.legal_entity_id = $1 AND w.voided_at IS NULL AND w.closed_on IS NULL \
           AND (SELECT r.name FROM workplace_revisions r WHERE r.workplace_id = w.id \
                ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) = $2 \
         ORDER BY w.created_at LIMIT 1",
    )
    .bind(entity)
    .bind(name)
    .fetch_optional(tx.as_mut())
    .await?)
}
