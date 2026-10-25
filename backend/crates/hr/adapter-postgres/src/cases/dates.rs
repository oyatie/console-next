// SPDX-License-Identifier: LicenseRef-Proprietary
//! Both statutory panels and dossiers use compliance's filing window calculation.
use crate::HrError;
use console_compliance_domain::statutory::StatutoryRegister;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) async fn refresh(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
    register: &StatutoryRegister,
) -> Result<(), HrError> {
    sqlx::query("UPDATE lifecycle_case_items i SET status='PENDING_TRIGGER',status_code=NULL,version=i.version+1 \
      FROM lifecycle_cases c JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=x.exit_lifecycle_event_id \
      WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND c.id=$2 AND l.state='SCHEDULED' \
      AND i.status IN ('OPEN','BLOCKED') AND i.requested_on IS NULL")
        .bind(org).bind(case).execute(tx.as_mut()).await?;
    super::applicability::apply(tx, org, case, register).await?;
    let rows = sqlx::query("SELECT i.id,i.kind,i.requested_on,i.due_basis,c.kind AS case_kind,c.effective_date,t.legal,t.due_anchor,t.due_rule_kind,COALESCE(i.due_rule_ref,t.due_register_code) AS due_register_code,\
      t.opens_on AS fixed_opens,COALESCE(i.opens_rule_ref,t.opens_rule_ref) AS opens_rule_ref,ct.release_disposition,s.case_opens_offset_days,s.recording_held,\
      (now() AT TIME ZONE lifecycle_time_zone(c.org_id,c.employee_id,c.effective_date,c.workplace_id))::date AS today, \
      lifecycle_go_live_on(c.org_id,c.employee_id,c.effective_date,c.workplace_id) AS go_live_on \
      FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
      JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
      JOIN case_templates ct ON ct.template_key=c.template_key AND ct.version=c.template_version \
      LEFT JOIN lifecycle_filing_rules s ON s.code=t.due_register_code AND s.effective_from<=c.effective_date \
        AND (s.effective_to_exclusive IS NULL OR c.effective_date<s.effective_to_exclusive) \
      WHERE i.org_id=$1 AND c.id=$2 AND c.state='OPEN' AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED') FOR UPDATE OF i")
        .bind(org).bind(case).fetch_all(tx.as_mut()).await?;
    let mut holds = Vec::new();
    let mut windows = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(held) = row.try_get::<Option<bool>, _>("recording_held")? {
            holds.push(serde_json::json!({"id":row.try_get::<Uuid,_>("id")?,"held":held}));
        }
        let super::window::Window {
            opens: opening,
            due,
            disposition,
            basis,
        } = super::window::calculate(&row, register)?;
        let mut basis = basis;
        if let Some(applicability) = row
            .try_get::<serde_json::Value, _>("due_basis")?
            .get("applicability")
        {
            basis["applicability"] = applicability.clone();
        }
        windows.push(serde_json::json!({"id":row.try_get::<Uuid,_>("id")?,"opens":opening.map(|d|d.to_string()),
            "opens_ref":row.try_get::<Option<String>,_>("opens_rule_ref")?,"due":due.map(|d|d.to_string()),
            "disposition":disposition,"basis":basis}));
    }
    sqlx::query("UPDATE lifecycle_case_items i SET blocks_close=t.blocks_close AND NOT r.held, \
      status=CASE WHEN r.held THEN 'BLOCKED' WHEN i.status_code='LEGAL_REVIEW' THEN 'OPEN' ELSE i.status END, \
      status_code=CASE WHEN r.held THEN 'LEGAL_REVIEW' WHEN i.status_code='LEGAL_REVIEW' THEN NULL ELSE i.status_code END,version=i.version+1 \
      FROM jsonb_to_recordset($3) r(id uuid,held boolean),case_template_items t,lifecycle_cases c \
      WHERE i.org_id=$1 AND i.case_id=$2 AND i.id=r.id AND c.org_id=i.org_id AND c.id=i.case_id \
      AND t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
      AND (i.blocks_close,i.status_code) IS DISTINCT FROM (t.blocks_close AND NOT r.held, \
        CASE WHEN r.held THEN 'LEGAL_REVIEW' WHEN i.status_code='LEGAL_REVIEW' THEN NULL ELSE i.status_code END)")
        .bind(org).bind(case).bind(serde_json::Value::Array(holds)).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_case_items i SET opens_on=r.opens, \
      opens_rule_ref=CASE WHEN r.disposition='PRE_CONSOLE' THEN i.opens_rule_ref ELSE r.opens_ref END,due_date=r.due, \
      due_disposition=CASE WHEN r.disposition='PRE_CONSOLE' THEN 'UNKNOWN' ELSE r.disposition END, \
      due_basis=CASE WHEN r.disposition='PRE_CONSOLE' THEN i.due_basis ELSE r.basis END, \
      status=CASE WHEN r.disposition='PRE_CONSOLE' THEN 'NOT_APPLICABLE' ELSE i.status END, \
      status_code=CASE WHEN r.disposition='PRE_CONSOLE' THEN 'PRE_CONSOLE' ELSE i.status_code END, \
      done_at=CASE WHEN r.disposition='PRE_CONSOLE' THEN now() ELSE i.done_at END,version=i.version+1 \
      FROM jsonb_to_recordset($3) r(id uuid,opens date,opens_ref text,due date,disposition text,basis jsonb) \
      WHERE i.org_id=$1 AND i.case_id=$2 AND i.id=r.id AND (r.disposition='PRE_CONSOLE' \
        OR (i.opens_on,i.opens_rule_ref,i.due_date,i.due_disposition,i.due_basis) IS DISTINCT FROM (r.opens,r.opens_ref,r.due,r.disposition,r.basis))")
        .bind(org).bind(case).bind(serde_json::Value::Array(windows)).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_case_items i SET status='OPEN',version=i.version+1 FROM lifecycle_cases c \
      WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND c.id=$2 AND i.status='PENDING_TRIGGER' \
      AND i.mode<>'REQUESTED' AND (i.opens_on IS NULL OR i.opens_on<=(now() AT TIME ZONE lifecycle_time_zone(c.org_id,c.employee_id,c.effective_date,c.workplace_id))::date) \
      AND NOT EXISTS(SELECT 1 FROM employee_lifecycle_events l WHERE l.org_id=c.org_id AND l.id=COALESCE((SELECT x.exit_lifecycle_event_id FROM employee_exit_cases x WHERE x.org_id=c.org_id AND x.id=c.exit_case_id),c.trigger_id) AND l.state='SCHEDULED')")
        .bind(org).bind(case).execute(tx.as_mut()).await?;
    super::open::filings(tx, org, case, register).await?;
    super::group_transfer::observe(tx, org, case).await?;
    super::hire_facts::observe(tx, org, case).await?;
    observe(tx, org, case).await
}

async fn observe(tx: &mut Transaction<'_, Postgres>, org: Uuid, case: Uuid) -> Result<(), HrError> {
    sqlx::query("UPDATE lifecycle_case_items i SET status='DONE_OBSERVED',observed_ref=jsonb_build_object('table','employee_lifecycle_events','id',l.id),\
      done_at=now(),version=i.version+1 FROM lifecycle_cases c LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) \
      WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND c.id=$2 AND i.item_key IN ('R1','X1','X2') \
      AND i.mode='OBSERVED' AND i.status IN ('OPEN','PENDING_TRIGGER') AND l.state='APPLIED'")
        .bind(org).bind(case).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_case_items i SET status='DONE_OBSERVED',observed_ref=jsonb_build_object('table','insurance_filing_records','id',r.id),\
      done_at=now(),version=i.version+1 FROM filing_obligations f JOIN LATERAL (SELECT r.* FROM insurance_filing_records r \
        WHERE r.org_id=f.org_id AND COALESCE(r.event_id,r.request_id)=f.event_id AND r.filing_kind=f.filing_kind AND r.insurer=f.insurer \
        ORDER BY r.version DESC LIMIT 1) r ON r.action='COMPLETE' \
      WHERE i.org_id=$1 AND i.case_id=$2 AND f.org_id=i.org_id AND f.id=i.filing_obligation_id AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED')")
        .bind(org).bind(case).execute(tx.as_mut()).await?;
    Ok(())
}
