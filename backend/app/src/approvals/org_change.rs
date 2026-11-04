// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::OrgId;
use console_platform_authz::{
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::{approval_document_list, org_change_step_decide},
        visible::load_facts,
    },
};
use sqlx::{Postgres, Transaction};
type Tx<'a> = Transaction<'a, Postgres>;
fn db(error: impl std::fmt::Display) -> KernelError {
    tracing::error!(error = %error, "approval projection unavailable");
    KernelError::internal("approval projection unavailable")
}
// One fact snapshot feeds list membership, counts, facets, focus and links.
pub(super) async fn visible(
    tx: &mut Tx<'_>,
    p: &Principal,
) -> Result<Vec<(Uuid, String)>, KernelError> {
    let access = load_facts(tx, p.org_id, *p.user_id.as_uuid()).await?;
    let node = NodeRef {
        kind: NodeKind::Tenant,
        id: *p.org_id.as_uuid(),
    };
    let read = access.authorize("org_change_read", node).map_err(db)?;
    let approve = access.authorize("org_change_approve", node).map_err(db)?;
    let rows: Vec<(Uuid, bool, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT r.id, r.drafted_by=$2, coalesce(h.participant,false), \
         r.status <> 'IN_APPROVAL', d.maker_person IS NOT NULL AND d.checker_person IS NOT NULL AND coalesce(h.bound,true), \
         coalesce(d.maker_person=d.checker_person,false) \
         FROM org_change_requests r \
         CROSS JOIN LATERAL public.console_decision_people($1,r.drafted_by,$2) d \
         LEFT JOIN LATERAL (SELECT bool_or(s.decided_by=$2 OR h.maker_person=h.checker_person) AS participant, \
           bool_and(h.maker_person IS NOT NULL AND h.checker_person IS NOT NULL) AS bound \
           FROM org_change_approval_steps s CROSS JOIN LATERAL public.console_decision_people($1,s.decided_by,$2) h \
           WHERE s.org_id=$1 AND s.request_id=r.id AND s.decision <> 'PENDING') h ON true \
         WHERE r.org_id=$1 AND r.status NOT IN ('DRAFT','PRECHECKED')")
        .bind(p.org_id.as_uuid()).bind(p.user_id.as_uuid()).fetch_all(tx.as_mut()).await.map_err(db)?;
    let actor = p.user_id.to_string();
    let org = p.org_id.to_string();
    let mut visible = Vec::new();
    for (id, requester, participant, completed, bound, same_person) in rows {
        // shortcut: org-change routes have tenant-wide authority, use step assignments when the source stores them.
        let can_decide = !completed
            && org_change_step_decide::enforce(
                &actor,
                &org,
                &org,
                org_change_step_decide::Facts {
                    holds_permission: approve,
                    identities_bound: bound,
                    actor_is_drafter: same_person,
                    actor_decided_prior_step: participant,
                    merge_requested: false,
                },
            )
            .is_ok();
        let facts = approval_document_list::Facts {
            read,
            requester,
            participant,
            can_decide,
            completed,
        };
        for box_name in BOXES {
            if approval_document_list::decide(&actor, &org, &org, facts, box_name).map_err(db)? {
                visible.push((id, box_name.to_owned()));
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
    visible: Vec<(Uuid, String)>,
) -> Result<Value, KernelError> {
    let (ids, boxes): (Vec<_>, Vec<_>) = visible.into_iter().unzip();
    sqlx::query_scalar(
        "WITH membership AS (SELECT * FROM unnest($2::uuid[], $3::text[]) AS v(id,box)), \
         eligible AS MATERIALIZED (SELECT r.*,v.box FROM membership v JOIN org_change_requests r ON r.id=v.id AND r.org_id=$1 \
           WHERE ($4::text IS NULL OR strpos(lower(r.code||' '||r.target_label||' '||r.reason),lower($4))>0) \
           AND ($5::text IS NULL OR $5='org_change')), \
         selected AS (SELECT * FROM eligible WHERE box=$6 AND ($7::timestamptz IS NULL OR (created_at,id)<($7,$8)) \
           ORDER BY created_at DESC,id DESC LIMIT $9+1), \
         wanted AS (SELECT * FROM selected UNION SELECT * FROM eligible WHERE box=$6 AND 'org_change:'||id=$10), \
         documents AS (SELECT r.id,r.created_at,jsonb_build_object( \
           'id','org_change:'||r.id,'box',r.box,'title',r.target_label,'summary',r.reason, \
           'document_no',r.code,'source',jsonb_build_object('key','org_change','label','조직 변경'), \
           'status',jsonb_build_object('key',r.status,'label',CASE r.status \
             WHEN 'IN_APPROVAL' THEN '결재 중' WHEN 'APPROVED' THEN '승인' WHEN 'APPLIED' THEN '시행 완료' \
             WHEN 'SETTLING' THEN '정산 중' WHEN 'ARCHIVED' THEN '종결' WHEN 'REJECTED' THEN '반려' ELSE '취소' END, \
             'tone',CASE WHEN r.status='REJECTED' THEN 'danger' WHEN r.box='pending' THEN 'warn' ELSE 'neutral' END), \
           'requester',jsonb_build_object('id',r.drafted_by,'name',u.display_name), \
           'requested_at',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
           'facts',jsonb_build_array(jsonb_build_object('key','effective_date','label','시행일','value',r.effective_date)), \
           'route',coalesce(s.route,'[]'::jsonb),'viewer',jsonb_build_object('kind','org_change','id',r.id)) AS document \
         FROM wanted r JOIN person_accounts_current u ON u.id=r.drafted_by AND u.org_id=r.org_id \
         LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',CASE s.role_key \
             WHEN 'hr' THEN '인사 결재' WHEN 'finance' THEN '재무 결재' WHEN 'legal' THEN '법무 결재' ELSE '임원 결재' END, \
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
             'key','org_change','label','조직 변경','count',(SELECT count(*) FROM eligible WHERE box=$6))) ELSE '[]'::jsonb END, \
           'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>$9 THEN \
             (SELECT (extract(epoch FROM created_at)*1000000000)::bigint::text||'~'||id FROM page ORDER BY created_at,id LIMIT 1) END)")
        .bind(org.as_uuid()).bind(ids).bind(boxes).bind(q.q.as_deref().filter(|s| !s.trim().is_empty())).bind(&q.source)
        .bind(&q.box_name).bind(after.map(|p| p.0)).bind(after.map(|p| p.1)).bind(q.limit.unwrap_or(50) as i64).bind(&q.focus)
        .fetch_one(tx.as_mut()).await.map_err(db)
}
