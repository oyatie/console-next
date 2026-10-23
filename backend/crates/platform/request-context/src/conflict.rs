//! Latest mutation metadata for a 409; never the old or new field values.
use crate::record_access;
use console_platform_authz::Principal;
use console_platform_db::{DbError, with_org_conn};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

pub fn redacted() -> Value {
    json!({"actor_name":null,"actor_kind":null,"recorded_at":null,"fields":[],"audit_id":null,"redacted":true})
}
pub async fn last_change(
    pool: &PgPool,
    p: &Principal,
    kind: &str,
    id: &str,
    branch: Option<Uuid>,
) -> Result<Value, DbError> {
    if !record_access::may_read(pool, p, kind, id, branch).await {
        return Ok(redacted());
    }
    let org = p.org_id;
    let target_kind = kind.to_owned();
    let kind = kind.to_owned();
    let target_id = id.to_owned();
    let id = id.to_owned();
    let row=with_org_conn(pool,org,move |tx| Box::pin(async move {
        Ok::<_,DbError>(sqlx::query("SELECT e.id,COALESCE(e.actor_display,u.display_name) AS actor_name,e.actor_kind,e.created_at,e.before_snap,e.after_snap,e.branch_id FROM audit_events e LEFT JOIN person_accounts_current u ON u.id=e.actor AND u.org_id=e.org_id WHERE e.org_id=$1 AND e.target_type=$2 AND e.target_id=$3 AND COALESCE(e.outcome,'ALLOWED')='ALLOWED' AND EXISTS(SELECT 1 FROM realtime_topic_map m WHERE m.target_type=e.target_type AND m.action=e.action) ORDER BY e.created_at DESC,e.id DESC LIMIT 1")
            .bind(org.as_uuid()).bind(kind).bind(id).fetch_optional(tx.as_mut()).await?)
    })).await?;
    let Some(row) = row else {
        return Ok(redacted());
    };
    let stored_branch: Option<Uuid> = row.try_get("branch_id")?;
    if !record_access::may_read(pool, p, &target_kind, &target_id, stored_branch).await {
        return Ok(redacted());
    }
    let before: Option<Value> = row.try_get("before_snap")?;
    let after: Option<Value> = row.try_get("after_snap")?;
    let fields = changed_fields(&before, &after);
    let at: time::OffsetDateTime = row.try_get("created_at")?;
    Ok(
        json!({"actor_name":row.try_get::<Option<String>,_>("actor_name")?,"actor_kind":row.try_get::<Option<String>,_>("actor_kind")?,"recorded_at":at.format(&Rfc3339).map_err(|e|DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?,"fields":fields,"audit_id":row.try_get::<Uuid,_>("id")?,"redacted":false}),
    )
}

fn changed_fields(before: &Option<Value>, after: &Option<Value>) -> Vec<String> {
    if let Some(fields) = after
        .as_ref()
        .and_then(|snapshot| snapshot.get("changed_fields"))
        .and_then(Value::as_array)
        .and_then(|fields| {
            fields
                .iter()
                .map(|field| field.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
    {
        return fields;
    }
    let mut names = std::collections::BTreeSet::new();
    for object in [before, after]
        .into_iter()
        .filter_map(|v| v.as_ref().and_then(Value::as_object))
    {
        names.extend(object.keys().cloned());
    }
    names
        .into_iter()
        .filter(|key| {
            before.as_ref().and_then(|v| v.get(key)) != after.as_ref().and_then(|v| v.get(key))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sealed_revision_fields_replace_metadata_without_exposing_values() {
        let snapshot =
            Some(json!({"version":3,"reason_code":"CORRECTION","changed_fields":["main_phone"]}));
        assert_eq!(changed_fields(&None, &snapshot), vec!["main_phone"]);
        assert_eq!(
            changed_fields(
                &Some(json!({"name":"before"})),
                &Some(json!({"name":"after"}))
            ),
            vec!["name"]
        );
    }
}
