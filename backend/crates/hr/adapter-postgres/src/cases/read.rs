// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{CaseItem, CaseItemPage, CaseItemQuery, LifecycleCase};
use crate::{
    HrError, HrService,
    authz::{Tier, hr_reach_in, out_of_scope},
};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    id: Uuid,
) -> Result<LifecycleCase, HrError> {
    let row = sqlx::query("SELECT c.id,c.employee_id,c.kind,c.state,COALESCE(x.exit_lifecycle_event_id,c.trigger_id) AS trigger_id,c.effective_date::text,c.linked_case_id,c.cancellation_reason,c.version FROM lifecycle_cases c \
      LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      WHERE c.org_id=$1 AND c.id=$2 FOR UPDATE OF c")
        .bind(p.org_id.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?
        .ok_or_else(||HrError::from_kernel(console_kernel_core::KernelError::not_found("lifecycle case")))?;
    let employee = row.try_get("employee_id")?;
    if !super::access::may(tx, p, Feature::EmployeeDirectoryRead, id).await? {
        return Err(out_of_scope(p, Feature::EmployeeDirectoryRead));
    }
    let register = console_platform_db::statutory_read::load_statutory_register(tx.as_mut())
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    super::dates::refresh(tx, *p.org_id.as_uuid(), id, &register).await?;
    Ok(LifecycleCase {
        id,
        employee_id: employee,
        kind: row.try_get("kind")?,
        state: row.try_get("state")?,
        trigger_id: row.try_get("trigger_id")?,
        effective_date: row.try_get("effective_date")?,
        linked_case_id: row.try_get("linked_case_id")?,
        cancellation_reason: row.try_get("cancellation_reason")?,
        version: row.try_get("version")?,
        items: items(tx, p, id).await?,
    })
}

async fn items(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    id: Uuid,
) -> Result<Vec<CaseItem>, HrError> {
    let mut items: Vec<CaseItem> = sqlx::query_as("SELECT i.id,i.case_id,i.item_key,COALESCE(i.label_ko,t.label_ko) AS label,t.label_key,i.kind,COALESCE(i.owner_line,t.owner_line) AS owner_line,\
      i.status,i.status_code,t.completion_rule_ref,t.waiver_rule_ref,t.record_target,i.completion_reason,COALESCE(f.filing_kind,s.filing_rule->>'filing_kind') AS filing_kind,COALESCE(f.insurer,s.filing_rule->>'insurer') AS insurer,i.opens_on::text,(i.opens_on-local.today)::bigint AS opens_in_days,\
      CASE WHEN i.due_disposition<>'UNKNOWN' THEN i.due_date::text END AS due_date,\
      CASE WHEN i.due_disposition<>'UNKNOWN' THEN (i.due_date-local.today)::bigint END AS due_in_days,\
      i.due_disposition,i.due_rule_ref,i.opens_rule_ref,\
      i.due_basis||jsonb_build_object('instrument',t.instrument_ko,'article',t.article_ko,'legal_review_required',i.legal AND COALESCE(s.recording_held,ct.release_disposition='HOLD')) AS basis,\
      i.blocks_close,i.observed_ref,i.exception_id,i.filing_obligation_id,i.version \
      FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
      JOIN case_templates ct ON ct.template_key=c.template_key AND ct.version=c.template_version \
      LEFT JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
      LEFT JOIN filing_obligations f ON f.org_id=i.org_id AND f.id=i.filing_obligation_id \
      LEFT JOIN LATERAL (SELECT s.filing_rule,s.recording_held FROM lifecycle_filing_rules s WHERE s.code=COALESCE(i.due_rule_ref,t.due_register_code) ORDER BY (s.effective_from<=c.effective_date AND (s.effective_to_exclusive IS NULL OR c.effective_date<s.effective_to_exclusive)) DESC,s.effective_from DESC LIMIT 1) s ON true \
      CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE lifecycle_time_zone(c.org_id,c.employee_id,c.effective_date,c.workplace_id))::date AS today) local \
      WHERE i.org_id=$1 AND i.case_id=$2 ORDER BY t.ord NULLS LAST,i.item_key")
        .bind(p.org_id.as_uuid()).bind(id).fetch_all(tx.as_mut()).await?;
    for item in &mut items {
        item.completion_risk = item
            .completion_rule_ref
            .as_deref()
            .and_then(|code| console_governance_domain::exception::RuleCode::parse(code).ok())
            .map(|rule| rule.risk().as_db_str().to_owned());
    }
    Ok(items)
}

pub(super) fn audit(p: &Principal, id: Uuid) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(p.user_id),
        AuditAction::new("lifecycle_case.updated")?,
        "lifecycle_case",
        id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(p.org_id))
}

impl HrService {
    pub async fn lifecycle_case(&self, p: Principal, id: Uuid) -> Result<LifecycleCase, HrError> {
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move { Ok((load(tx, &p, id).await?, Vec::new())) })
        })
        .await
    }
    pub async fn employee_lifecycle_cases(
        &self,
        p: Principal,
        employee: Uuid,
    ) -> Result<Vec<LifecycleCase>, HrError> {
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move |tx|Box::pin(async move {
            hr_reach_in(&p,Feature::EmployeeDirectoryRead,Tier::Branch)?;
            let ids:Vec<Uuid> = sqlx::query_scalar("SELECT id FROM lifecycle_cases WHERE org_id=$1 AND employee_id=$2 ORDER BY effective_date DESC,opened_at DESC,id")
                .bind(p.org_id.as_uuid()).bind(employee).fetch_all(tx.as_mut()).await?;
            let mut cases=Vec::new();
            for id in ids {if super::access::may(tx,&p,Feature::EmployeeDirectoryRead,id).await? {cases.push(load(tx,&p,id).await?);}}
            Ok((cases,Vec::new()))
        })).await
    }
    /// G2 consumes this page; ownership is checked against each stored Cedar line.
    pub async fn lifecycle_case_items(
        &self,
        p: Principal,
        q: CaseItemQuery,
    ) -> Result<CaseItemPage, HrError> {
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move |tx|Box::pin(async move {
            let rows:Vec<(Uuid,Uuid,Option<String>)> = sqlx::query_as("SELECT i.id,c.id,COALESCE(i.owner_line,t.owner_line) FROM lifecycle_cases c JOIN lifecycle_case_items i ON i.org_id=c.org_id AND i.case_id=c.id \
              LEFT JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
              WHERE c.org_id=$1 AND c.state='OPEN' AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED') AND ($2::uuid IS NULL OR i.id>$2) ORDER BY i.id")
                .bind(p.org_id.as_uuid()).bind(q.after).fetch_all(tx.as_mut()).await?;
            let limit=q.limit.unwrap_or(50).clamp(1,200) as usize;
            let mut selected=Vec::new();
            for (item,case,line) in rows {
                if super::access::may(tx,&p,Feature::EmployeeDirectoryRead,case).await?
                  && super::write::holds_owner(tx,&p,case,line.as_deref()).await? {
                    selected.push((item,case));
                    if selected.len()>limit {break;}
                }
            }
            let more=selected.len()>limit;selected.truncate(limit);
            // Advance past evaluated rows even if refreshing their basis excludes one.
            let next=selected.last().filter(|_|more).map(|(item,_)|*item);
            let wanted:std::collections::BTreeSet<_>=selected.iter().map(|(item,_)|*item).collect();
            let cases:std::collections::BTreeSet<_>=selected.into_iter().map(|(_,case)|case).collect();
            let mut page=Vec::new();
            for case in cases {
                for item in load(tx,&p,case).await?.items {
                    if wanted.contains(&item.id) && matches!(item.status.as_str(),"OPEN"|"PENDING_TRIGGER"|"BLOCKED") {page.push(item);}
                }
            }
            page.sort_by_key(|i|i.id);
            Ok((CaseItemPage{items:page,next},Vec::new()))
        })).await
    }
}
