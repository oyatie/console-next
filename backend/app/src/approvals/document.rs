// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_authz::cedar_pbac::actions::approval_document_read;
use console_settings_domain::code_lists::{NOTE_MAX_CHARS, ReasonDomain};
use serde_json::json;
use sha2::{Digest, Sha256};

/// The longest opinion a decision takes: it shares the step's 2000-character
/// memo with a rejection's note, so neither is ever dropped.
pub(super) const OPINION_MAX: usize = 2000 - NOTE_MAX_CHARS - 2;

/// A document as its viewer reads it, with what a decision on it needs.
pub(super) struct Loaded {
    pub document: Value,
    /// The source's decision version in this snapshot.
    pub version: String,
    /// The step awaiting a decision, only where the viewer is offered one.
    pub step: Option<Uuid>,
}

/// The source record an approval id names (`org_change:<uuid>` today).
pub(super) fn source_id(key: &str) -> Option<Uuid> {
    key.strip_prefix("org_change:")
        .and_then(|s| Uuid::parse_str(s).ok())
}

pub(super) async fn get(
    State(state): State<Approvals>,
    Extension(principal): Extension<Principal>,
    Path(key): Path<String>,
) -> Result<Json<Value>, InboxError> {
    let Some(id) = source_id(&key) else {
        return Err(missing().into());
    };
    let loaded = console_platform_db::with_org_locking_snapshot::<_, _, crate::error::AppError>(
        &state.pool,
        principal.org_id,
        move |tx| Box::pin(async move { Ok(read(tx, &principal, id, key).await) }),
    )
    .await
    .map_err(db)??;
    Ok(Json(loaded.ok_or_else(missing)?.document))
}

pub(super) async fn read(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: &Principal,
    id: Uuid,
    key: String,
) -> Result<Option<Loaded>, KernelError> {
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
    // A decision is offered exactly where the source command takes one from
    // this viewer: their turn, no refusal, in approval, a step awaiting it.
    // Added after the fingerprint: it describes the viewer, not the document.
    let route = document["route"].as_array().cloned().unwrap_or_default();
    let offered = document["box"] == "pending"
        && document["decision_refusal"].is_null()
        && document["status"]["key"] == "IN_APPROVAL";
    let step = route
        .iter()
        .find(|step| step["state"] == "current")
        .and_then(|step| step["id"].as_str())
        .and_then(|id| Uuid::parse_str(id).ok())
        .filter(|_| offered);
    let undecided = route
        .iter()
        .filter(|step| step["state"] == "current" || step["state"] == "waiting")
        .count();
    document["consequence"] = json!(match step {
        Some(_) if undecided == 1 => "final",
        Some(_) => "next_step",
        None => "",
    });
    document["opinion_max"] = json!(if step.is_some() { OPINION_MAX } else { 0 });
    // Return for supplement is not offered: the source has no such transition.
    document["my_actions"] = if step.is_some() {
        json!({"kind":"approve","reject":{"consequence":"request_ends","reason_domain":ReasonDomain::OrgChangeReject.as_str()}})
    } else {
        json!({"kind":"none"})
    };
    // The same timestamp the source command checks `expected_version` against.
    let changed: OffsetDateTime = sqlx::query_scalar(
        "SELECT greatest(r.updated_at, max(s.decided_at)) FROM org_change_requests r \
         LEFT JOIN org_change_approval_steps s ON s.request_id=r.id \
         WHERE r.org_id=$1 AND r.id=$2 GROUP BY r.updated_at",
    )
    .bind(p.org_id.as_uuid())
    .bind(id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(db)?;
    Ok(Some(Loaded {
        document,
        version: console_orgchange_domain::decision_version(changed, None),
        step,
    }))
}

pub(super) fn missing() -> KernelError {
    KernelError::not_found("approval document not found")
}
