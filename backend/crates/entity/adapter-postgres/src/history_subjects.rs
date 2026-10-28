// SPDX-License-Identifier: LicenseRef-Proprietary
//! Subject keys travel beside the history snapshot, never through its wire shape.
use super::*;
use console_entity_application::{FieldChange, WORKPLACE_PERSONAL_FIELDS};

pub(super) fn workplace_fields() -> String {
    format!(
        "ARRAY[{}]::text[]",
        WORKPLACE_PERSONAL_FIELDS
            .iter()
            .map(|field| format!("'{}'", field.name()))
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(super) fn query(record: Record) -> String {
    let fields = match record {
        Record::Entity => &[
            (
                "representatives",
                "legal_entity_representatives",
                "legal_entity_revisions",
                "legal_entity_id",
            ),
            (
                "directors",
                "legal_entity_directors",
                "legal_entity_revisions",
                "legal_entity_id",
            ),
        ][..],
        Record::Registration => &[(
            "co_owners",
            "business_registration_co_owners",
            "business_registration_revisions",
            "registration_id",
        )][..],
        Record::Workplace => &[][..],
    };
    let fields = if matches!(record, Record::Workplace) {
        return format!(
            "SELECT h.*,CASE WHEN $2 AND h.chain='' THEN \
             (SELECT COALESCE(jsonb_object_agg(k, jsonb_build_array('workplace_revisions:' || $1::text || ':' || h.version)), '{{}}'::jsonb) \
              FROM jsonb_each(h.state) e(k,v) WHERE k=ANY({}) AND v<>'null'::jsonb) \
             ELSE '{{}}'::jsonb END AS access_subjects FROM ({}) h ORDER BY h.created_at,h.version",
            workplace_fields(),
            sql(record)
        );
    } else {
        fields.iter().map(|(field, table, revisions, key)| format!(
        "'{field}',(SELECT jsonb_agg('{table}:' || $1::text || ':' || r.version || ':' || p.seq ORDER BY p.seq) \
         FROM {revisions} r JOIN {table} p ON p.revision_id=r.id WHERE r.{key}=$1 AND r.version=h.version)"
        )).collect::<Vec<_>>().join(",")
    };
    format!(
        "SELECT h.*,CASE WHEN $2 THEN jsonb_build_object({fields}) ELSE '{{}}'::jsonb END AS access_subjects FROM ({}) h ORDER BY h.created_at,h.version",
        sql(record)
    )
}

pub(super) fn collect(
    row: &sqlx::postgres::PgRow,
    changes: &[FieldChange],
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Result<Vec<String>, PgEntityError> {
    let mut subjects = Vec::new();
    for change in changes {
        for state in [before, after] {
            if let Some(refs) = state.get(&change.field).and_then(Value::as_array) {
                subjects.extend(refs.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
    if row.try_get::<Option<String>, _>("actor_name")?.is_some()
        && let Some(actor) = row.try_get::<Option<Uuid>, _>("actor_id")?
    {
        subjects.push(format!("users:{actor}"));
    }
    subjects.sort_unstable();
    subjects.dedup();
    Ok(subjects)
}
