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
        move |tx| {
            Box::pin(async move {
                read(tx, &principal, id, key)
                    .await
                    .map_err(|e| crate::error::AppError::Internal(e.to_string()))
            })
        },
    )
    .await
    .map_err(db)?;
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
    let (source, revision, body): (Value, i64, Value) = sqlx::query_as(
        "SELECT jsonb_build_object('request',to_jsonb(r),'steps', \
           (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.step_order) FROM org_change_approval_steps s WHERE s.org_id=r.org_id AND s.request_id=r.id)), \
         (SELECT count(*)+1 FROM org_change_events e WHERE e.org_id=r.org_id AND e.request_id=r.id), \
         jsonb_build_array(jsonb_build_object('key','target','label','대상','value',r.target_label), \
           jsonb_build_object('key','effective_date','label','시행일','value',r.effective_date), \
           jsonb_build_object('key','reason','label','사유','value',r.reason)) \
         FROM org_change_requests r WHERE r.org_id=$1 AND r.id=$2"
    ).bind(p.org_id.as_uuid()).bind(id).fetch_one(tx.as_mut()).await.map_err(db)?;
    // Cover the source proposal and signer facts even when a writer preserves timestamps.
    let mut facts = document.clone();
    facts["box"] = Value::Null;
    let fingerprint = hex::encode(Sha256::digest(
        json!([source, facts, revision]).to_string().as_bytes(),
    ));
    document["body"] = body;
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
