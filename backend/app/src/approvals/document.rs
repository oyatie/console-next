// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_authz::cedar_pbac::actions::approval_document_read;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(super) async fn get(
    State(pool): State<sqlx::PgPool>,
    Extension(principal): Extension<Principal>,
    Path(key): Path<String>,
) -> Result<Json<Value>, InboxError> {
    let id = key
        .strip_prefix("org_change:")
        .and_then(|s| Uuid::parse_str(s).ok());
    let Some(id) = id else {
        return Err(missing().into());
    };
    let document = console_platform_db::with_org_locking_snapshot::<_, _, crate::error::AppError>(
        &pool,
        principal.org_id,
        move |tx| Box::pin(async move { Ok(read(tx, &principal, id, key).await) }),
    )
    .await
    .map_err(db)??;
    Ok(Json(document.ok_or_else(missing)?))
}

async fn read(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: &Principal,
    id: Uuid,
    key: String,
) -> Result<Option<Value>, KernelError> {
    let membership = org_change::visible(tx, p).await?;
    let box_name = membership
        .iter()
        .find(|(record, _, _)| *record == id)
        .map(|(_, name, _)| name.clone());
    let org = p.org_id.to_string();
    if !approval_document_read::decide(&p.user_id.to_string(), &org, &org, box_name.is_some())
        .map_err(db)?
    {
        return Ok(None);
    }
    let q = ListQuery {
        box_name: box_name.ok_or_else(missing)?,
        q: None,
        source: None,
        focus: Some(key),
        cursor: None,
        limit: Some(1),
    };
    let page = org_change::page(tx, p.org_id, &q, None, membership).await?;
    let mut document = page["focused"].clone();
    if document.is_null() {
        return Ok(None);
    }
    let (source, revision, proposal): (Value, i64, Value) = sqlx::query_as(
        "SELECT jsonb_build_object('request',to_jsonb(r),'steps', \
           (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.step_order) FROM org_change_approval_steps s WHERE s.org_id=r.org_id AND s.request_id=r.id)), \
         (SELECT count(*)+1 FROM org_change_events e WHERE e.org_id=r.org_id AND e.request_id=r.id), r.proposal \
         FROM org_change_requests r WHERE r.org_id=$1 AND r.id=$2"
    ).bind(p.org_id.as_uuid()).bind(id).fetch_one(tx.as_mut()).await.map_err(db)?;
    let names: Value = sqlx::query_scalar(
        "WITH refs AS (SELECT DISTINCT f.value FROM jsonb_array_elements($2::jsonb) op \
           CROSS JOIN LATERAL jsonb_each_text(op) f \
           WHERE f.key IN ('orgUnitId','parentId','fromOrgUnit','toOrgUnit','mergedInto')) \
         SELECT coalesce(jsonb_object_agg(u.id,latest.attributes->>'name'),'{}'::jsonb) \
         FROM org_units u JOIN refs ON u.id::text=refs.value \
         JOIN LATERAL (SELECT attributes FROM org_unit_revisions r \
           WHERE r.org_id=u.org_id AND r.org_unit_id=u.id ORDER BY r.version DESC LIMIT 1) latest ON true \
         WHERE u.org_id=$1 AND latest.attributes->>'name' IS NOT NULL"
    ).bind(p.org_id.as_uuid()).bind(&proposal).fetch_one(tx.as_mut()).await.map_err(db)?;
    document["proposal_names"] = names;
    // Cover the source proposal and signer facts even when a writer preserves timestamps.
    let mut facts = document.clone();
    facts["box"] = Value::Null;
    facts["decision_refusal"] = Value::Null;
    let fingerprint = hex::encode(Sha256::digest(
        json!([source, facts, revision]).to_string().as_bytes(),
    ));
    document["body"] = json!([]);
    document["proposal"] = proposal;
    document["revision"] = json!(revision);
    document["fingerprint"] = json!(fingerprint);
    // shortcut: read-only envelope until the canonical source-command adapter ships.
    document["consequence"] = json!("");
    document["opinion_max"] = json!(0);
    document["my_actions"] = json!({"kind":"none"});
    Ok(Some(document))
}

fn missing() -> KernelError {
    KernelError::not_found("approval document not found")
}
