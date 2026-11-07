// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::OrgId;
use console_orgchange_adapter_postgres::{StepDecisionScope, step_decision_facts_in_tx};
use console_platform_authz::cedar_pbac::actions::{approval_document_list, org_change_step_decide};
use sqlx::{Postgres, Transaction};
type Tx<'a> = Transaction<'a, Postgres>;
#[derive(Deserialize)]
struct SourceLabels {
    ko: String,
}
// One fact snapshot feeds list membership, counts, facets, focus and links.
pub(super) async fn visible(
    tx: &mut Tx<'_>,
    p: &Principal,
) -> Result<Vec<(Uuid, String, Option<String>)>, KernelError> {
    let rows = step_decision_facts_in_tx(tx, p.org_id, p.user_id, StepDecisionScope::Submitted)
        .await
        .map_err(db)?;
    let actor = p.user_id.to_string();
    let org = p.org_id.to_string();
    let mut visible = Vec::new();
    for row in rows {
        let refusal = org_change_step_decide::enforce(&actor, &org, &org, row.decision)
            .err()
            .filter(|_| !row.completed)
            .and_then(|error| error.code)
            .map(str::to_owned);
        let facts = row.approval_list_facts();
        for box_name in BOXES {
            if approval_document_list::decide(&actor, &org, &org, facts, box_name).map_err(db)? {
                visible.push((
                    row.id,
                    box_name.to_owned(),
                    refusal.clone().filter(|_| box_name == "pending"),
                ));
            }
        }
    }
    Ok(visible)
}
pub(super) async fn page(
    tx: &mut Tx<'_>,
    org: OrgId,
    q: &ListQuery,
    after: Option<(OffsetDateTime, Uuid)>,
    visible: Vec<(Uuid, String, Option<String>)>,
) -> Result<Value, KernelError> {
    let labels: SourceLabels = serde_json::from_str(include_str!(
        "../../../../packages/i18n/src/catalogs/approval-sources.json"
    ))
    .map_err(db)?;
    let mut ids = Vec::new();
    let mut boxes = Vec::new();
    let mut refusals = Vec::new();
    for (id, box_name, refusal) in visible {
        ids.push(id);
        boxes.push(box_name);
        refusals.push(refusal);
    }
    sqlx::query_scalar(
        "WITH membership AS (SELECT * FROM unnest($2::uuid[], $3::text[], $11::text[]) AS v(id,box,refusal)), \
         eligible AS MATERIALIZED (SELECT r.*,v.box,v.refusal FROM membership v JOIN org_change_requests r ON r.id=v.id AND r.org_id=$1 \
           WHERE ($4::text IS NULL OR strpos(lower(r.code||' '||r.target_label||' '||r.reason),lower($4))>0) \
           AND ($5::text IS NULL OR $5='org_change')), \
         selected AS (SELECT * FROM eligible WHERE box=$6 AND ($7::timestamptz IS NULL OR (created_at,id)<($7,$8)) \
           ORDER BY created_at DESC,id DESC LIMIT $9+1), \
         wanted AS (SELECT * FROM selected UNION SELECT * FROM eligible WHERE box=$6 AND 'org_change:'||id=$10), \
         documents AS (SELECT r.id,r.created_at,jsonb_build_object( \
           'id','org_change:'||r.id,'box',r.box,'title',r.target_label,'summary',r.reason, \
           'document_no',r.code,'decision_refusal',r.refusal,'source',jsonb_build_object('key','org_change','label',$12::text), \
           'status',jsonb_build_object('key',r.status), \
           'requester',jsonb_build_object('id',r.drafted_by,'name',u.display_name), \
           'requested_at',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
           'facts','[]'::jsonb,'effective_date',r.effective_date, \
           'route',coalesce(s.route,'[]'::jsonb),'viewer',jsonb_build_object('kind','org_change','id',r.id)) AS document \
         FROM wanted r JOIN person_accounts_current u ON u.id=r.drafted_by AND u.org_id=r.org_id \
         LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',s.id,'role_key',s.role_key, \
           'assignee',coalesce(d.display_name,''),'state',CASE WHEN s.decision='REJECTED' THEN 'failed' WHEN s.decision<>'PENDING' THEN 'done' \
           WHEN r.status='IN_APPROVAL' AND s.step_order=(SELECT min(n.step_order) FROM org_change_approval_steps n \
             WHERE n.org_id=r.org_id AND n.request_id=r.id AND n.decision='PENDING') THEN 'current' ELSE 'waiting' END) ORDER BY s.step_order) AS route \
           FROM org_change_approval_steps s LEFT JOIN person_accounts_current d ON d.id=s.decided_by AND d.org_id=s.org_id \
           WHERE s.org_id=r.org_id AND s.request_id=r.id) s ON true), \
         page AS (SELECT d.* FROM documents d JOIN selected s USING(id) ORDER BY d.created_at DESC,d.id DESC LIMIT $9) \
         SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(document ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb), \
           'focused',(SELECT document FROM documents WHERE 'org_change:'||id=$10), \
           'counts',(SELECT jsonb_object_agg(b,(SELECT count(*) FROM eligible e WHERE e.box=b)) \
             FROM unnest(ARRAY['pending','upcoming','requested','reference','completed']) b), \
           'sources',CASE WHEN EXISTS(SELECT 1 FROM eligible WHERE box=$6) THEN jsonb_build_array(jsonb_build_object( \
             'key','org_change','label',$12::text,'count',(SELECT count(*) FROM eligible WHERE box=$6))) ELSE '[]'::jsonb END, \
           'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>$9 THEN \
             (SELECT (extract(epoch FROM created_at)*1000000000)::bigint::text||'~'||id FROM page ORDER BY created_at,id LIMIT 1) END)")
        .bind(org.as_uuid()).bind(ids).bind(boxes).bind(q.q.as_deref().filter(|s| !s.trim().is_empty())).bind(&q.source)
        .bind(&q.box_name).bind(after.map(|p| p.0)).bind(after.map(|p| p.1)).bind(q.limit.unwrap_or(50) as i64).bind(&q.focus).bind(refusals).bind(labels.ko)
        .fetch_one(tx.as_mut()).await.map_err(db)
}
