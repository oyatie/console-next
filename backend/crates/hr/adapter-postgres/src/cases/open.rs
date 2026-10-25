// SPDX-License-Identifier: LicenseRef-Proprietary
//! Openers run on the event writer's connection; a rollback removes the dossier too.
use crate::HrError;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
) -> Result<(), HrError> {
    event_with_register(tx, org, event, None).await
}
pub(crate) async fn event_with_register(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
    register: Option<&console_compliance_domain::statutory::StatutoryRegister>,
) -> Result<(), HrError> {
    events_with_register(tx, org, std::slice::from_ref(&event), register).await
}

pub(crate) async fn events_with_register(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    events: &[Uuid],
    register: Option<&console_compliance_domain::statutory::StatutoryRegister>,
) -> Result<(), HrError> {
    let cases: Vec<Uuid> = sqlx::query_scalar(
        "INSERT INTO lifecycle_cases (org_id,id,kind,variant,subject_kind,employee_id,employment_id,branch_id,org_unit_id,\
         legal_entity_id,workplace_id,trigger_kind,trigger_id,effective_date,template_key,template_version,opened_by) \
         SELECT l.org_id,COALESCE(x.id,gen_random_uuid()),m.case_kind,CASE WHEN m.case_kind='APPOINT' AND l.to_workplace_id IS NOT NULL AND (SELECT previous.workplace_id FROM employment_assignments previous WHERE previous.org_id=l.org_id AND previous.employee_id=l.employee_id AND previous.superseded_at IS NULL AND previous.valid_from<l.effective_date::date ORDER BY previous.valid_from DESC LIMIT 1) IS DISTINCT FROM l.to_workplace_id THEN 'WORKPLACE_CHANGE' END,'EMPLOYMENT',l.employee_id,b.employment_id,COALESCE((SELECT w.default_branch_id FROM workplaces w WHERE w.org_id=l.org_id AND w.id=COALESCE(l.to_workplace_id,a.workplace_id)),e.home_branch_id),CASE WHEN l.event_type='GROUP_TRANSFER' THEN COALESCE(l.to_org_unit_id,e.org_unit_id) ELSE COALESCE(l.to_org_unit_id,l.from_org_unit_id,e.org_unit_id) END,\
         a.legal_entity_id,COALESCE(l.to_workplace_id,a.workplace_id),\
         CASE WHEN x.id IS NULL THEN 'LIFECYCLE_EVENT' ELSE 'EXIT_CASE' END,\
         COALESCE(x.id,l.id),l.effective_date::date,t.template_key,t.version,l.created_by \
         FROM employee_lifecycle_events l JOIN lifecycle_case_triggers m ON m.event_type=l.event_type \
         JOIN person_employees_current e ON e.org_id=l.org_id AND e.id=l.employee_id \
         LEFT JOIN employment_source_bindings b ON b.org_id=l.org_id AND b.employee_id=l.employee_id \
         LEFT JOIN LATERAL (SELECT * FROM employment_assignments a WHERE a.org_id=l.org_id AND a.employee_id=l.employee_id \
           AND a.superseded_at IS NULL AND a.valid_from<=l.effective_date::date ORDER BY a.valid_from DESC LIMIT 1) a ON true \
         LEFT JOIN employee_exit_cases x ON x.org_id=l.org_id AND x.employee_id=l.employee_id AND m.case_kind='EXIT' \
           AND (x.exit_lifecycle_event_id=l.id OR (l.event_type='TERMINATE' AND x.id::text=current_setting('app.confirming_exit_case',true))) \
         JOIN LATERAL (SELECT * FROM case_templates t WHERE t.template_key=m.template_key AND t.effective_from<=l.effective_date::date \
           AND (t.effective_to_exclusive IS NULL OR l.effective_date::date<t.effective_to_exclusive) ORDER BY t.effective_from DESC LIMIT 1) t ON true \
         WHERE l.org_id=$1 AND l.id=ANY($2) AND l.state IN ('APPLIED','SCHEDULED') \
           AND NOT (l.event_type='REHIRE' AND l.to_status='PRE_HIRE') \
         ON CONFLICT DO NOTHING RETURNING id",
    ).bind(org).bind(events).fetch_all(tx.as_mut()).await?;
    items_many(tx, org, &cases).await?;
    if let Some(register) = register {
        // Operational UNKNOWN rows need no legal calculation; event receipts were inserted above.
        let dated: Vec<Uuid> = sqlx::query_scalar("SELECT c.id FROM lifecycle_cases c WHERE c.org_id=$1 AND c.id=ANY($2) \
          AND EXISTS(SELECT 1 FROM case_template_items t WHERE t.template_key=c.template_key AND t.version=c.template_version \
            AND (t.variants IS NULL OR c.variant=ANY(t.variants)) AND (t.legal OR t.due_rule_kind<>'UNKNOWN' OR t.opens_on IS NOT NULL OR t.opens_rule_ref IS NOT NULL OR cardinality(t.applicability)>0))")
            .bind(org).bind(&cases).fetch_all(tx.as_mut()).await?;
        for id in dated {
            super::dates::refresh(tx, org, id, register).await?;
        }
    } else {
        for id in cases {
            initialise(tx, org, id).await?;
        }
    }
    // Applying a scheduled event releases only its event gate; legal windows remain separate.
    sqlx::query("UPDATE lifecycle_case_items i SET status='OPEN',version=i.version+1 FROM lifecycle_cases c,employee_lifecycle_events l \
      WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND l.org_id=c.org_id AND l.id=ANY($2) \
      AND c.trigger_id=l.id AND l.state='APPLIED' AND i.status='PENDING_TRIGGER' AND i.mode<>'REQUESTED' \
      AND (i.opens_on IS NULL OR i.opens_on<=l.effective_date::date)")
        .bind(org).bind(events).execute(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn exit(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    exit: Uuid,
) -> Result<(), HrError> {
    sqlx::query("INSERT INTO lifecycle_cases (org_id,id,kind,variant,subject_kind,employee_id,employment_id,branch_id,org_unit_id,legal_entity_id,workplace_id,\
      trigger_kind,trigger_id,effective_date,template_key,template_version,opened_by) \
      SELECT x.org_id,x.id,'EXIT',lifecycle_exit_variant(x.exit_reason_code),'EMPLOYMENT',x.employee_id,x.employment_id,x.branch_id,e.org_unit_id,a.legal_entity_id,a.workplace_id,\
      'EXIT_CASE',x.id,x.effective_exit_date,t.template_key,t.version,x.reported_by FROM employee_exit_cases x \
      JOIN person_employees_current e ON e.org_id=x.org_id AND e.id=x.employee_id \
      LEFT JOIN LATERAL (SELECT a.legal_entity_id,a.workplace_id FROM employment_assignments a WHERE a.org_id=x.org_id AND a.employee_id=x.employee_id \
        AND a.superseded_at IS NULL AND a.valid_from<=x.effective_exit_date ORDER BY a.valid_from DESC LIMIT 1) a ON true \
      JOIN LATERAL (SELECT * FROM case_templates WHERE kind='EXIT' AND effective_from<=x.effective_exit_date \
        AND (effective_to_exclusive IS NULL OR x.effective_exit_date<effective_to_exclusive) ORDER BY effective_from DESC LIMIT 1) t ON true \
      WHERE x.org_id=$1 AND x.id=$2 ON CONFLICT DO NOTHING")
        .bind(org).bind(exit).execute(tx.as_mut()).await?;
    items(tx, org, exit).await?;
    initialise(tx, org, exit).await
}

pub(crate) async fn items(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
) -> Result<(), HrError> {
    items_many(tx, org, std::slice::from_ref(&case)).await
}
async fn items_many(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    cases: &[Uuid],
) -> Result<(), HrError> {
    sqlx::query("INSERT INTO lifecycle_case_items (org_id,case_id,item_key,source,template_item_version,kind,venue,mode,owner_line,\
      due_rule_ref,opens_rule_ref,due_disposition,status,blocks_close,legal,observed_ref,done_at) \
      SELECT c.org_id,c.id,t.item_key,'TEMPLATE',t.version,t.kind,t.venue,t.mode,t.owner_line,\
      t.due_register_code,t.opens_rule_ref,CASE WHEN t.due_rule_kind='UNKNOWN' THEN 'UNKNOWN' ELSE 'HOLD' END,\
      CASE WHEN t.mode='OBSERVED' AND t.item_key='R1' AND l.state='APPLIED' THEN 'DONE_OBSERVED' \
        WHEN t.mode='REQUESTED' OR l.state='SCHEDULED' THEN 'PENDING_TRIGGER' ELSE 'OPEN' END,t.blocks_close,t.legal, \
      CASE WHEN t.mode='OBSERVED' AND t.item_key='R1' AND l.state='APPLIED' THEN jsonb_build_object('table','employee_lifecycle_events','id',l.id) END, \
      CASE WHEN t.mode='OBSERVED' AND t.item_key='R1' AND l.state='APPLIED' THEN now() END \
      FROM lifecycle_cases c JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version \
      LEFT JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=c.trigger_id \
      WHERE c.org_id=$1 AND c.id=ANY($2) AND (t.variants IS NULL OR c.variant=ANY(t.variants)) \
      ON CONFLICT DO NOTHING")
        .bind(org).bind(cases).execute(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn cancel(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
    reason: &str,
) -> Result<(), HrError> {
    sqlx::query("SELECT c.id FROM lifecycle_cases c LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      WHERE c.org_id=$1 AND (c.trigger_id=$2 OR x.exit_lifecycle_event_id=$2) ORDER BY c.id FOR UPDATE OF c")
        .bind(org).bind(event).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_case_items i SET status='CANCELLED',status_code='EVENT_WITHDRAWN',done_at=now(),version=i.version+1 \
      FROM lifecycle_cases c LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND (c.trigger_id=$2 OR x.exit_lifecycle_event_id=$2) \
      AND i.status IN ('PENDING_TRIGGER','OPEN','BLOCKED')")
        .bind(org).bind(event).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_cases c SET state='CANCELLED',closed_at=now(),close_basis=NULL,cancellation_reason=COALESCE((SELECT l.cancel_reason FROM employee_lifecycle_events l WHERE l.org_id=c.org_id AND l.id=$2),$3),version=c.version+1 \
      WHERE c.org_id=$1 AND c.state IN ('OPEN','CANCELLED') AND (c.trigger_id=$2 OR EXISTS(SELECT 1 FROM employee_exit_cases x \
      WHERE x.org_id=c.org_id AND x.id=c.exit_case_id AND x.exit_lifecycle_event_id=$2))")
        .bind(org).bind(event).bind(reason).execute(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn filings(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
    register: &console_compliance_domain::statutory::StatutoryRegister,
) -> Result<(), HrError> {
    let rows = sqlx::query("SELECT i.id,i.due_rule_ref,c.effective_date,c.trigger_id,c.exit_case_id,x.exit_lifecycle_event_id \
      FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
      LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
      WHERE i.org_id=$1 AND c.id=$2 AND i.kind='FIL' AND i.filing_obligation_id IS NULL AND i.status<>'NOT_APPLICABLE'")
        .bind(org).bind(case).fetch_all(tx.as_mut()).await?;
    let mut links = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(code) = row.try_get::<Option<String>, _>("due_rule_ref")? else {
            continue;
        };
        let Some(rule) = register.filing_rule_by_code(&code, row.try_get("effective_date")?)?
        else {
            continue;
        };
        let event = row
            .try_get::<Option<Uuid>, _>("exit_lifecycle_event_id")?
            .or_else(|| {
                if row.get::<Option<Uuid>, _>("exit_case_id").is_none() {
                    row.get("trigger_id")
                } else {
                    None
                }
            });
        let Some(event) = event else { continue };
        links.push(
            serde_json::json!({"item":row.try_get::<Uuid,_>("id")?,"event":event,
            "kind":rule.filing_kind,"insurer":rule.insurer}),
        );
    }
    if links.is_empty() {
        return Ok(());
    }
    let links = serde_json::Value::Array(links);
    sqlx::query("INSERT INTO filing_obligations (org_id,event_id,filing_kind,insurer) \
      SELECT DISTINCT $1,r.event,r.kind,r.insurer FROM jsonb_to_recordset($2) r(event uuid,kind text,insurer text) ON CONFLICT DO NOTHING")
        .bind(org).bind(&links).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_case_items SET filing_obligation_id=f.id \
      FROM jsonb_to_recordset($2) r(item uuid,event uuid,kind text,insurer text),filing_obligations f \
      WHERE lifecycle_case_items.org_id=$1 AND lifecycle_case_items.id=r.item AND f.org_id=$1 \
      AND f.event_id=r.event AND f.filing_kind=r.kind AND f.insurer=r.insurer")
        .bind(org).bind(links).execute(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn initialise(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
) -> Result<(), HrError> {
    let register = console_platform_db::statutory_read::load_statutory_register(tx.as_mut())
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    super::dates::refresh(tx, org, case, &register).await
}

pub(crate) async fn place(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    on: Option<&str>,
    branch: Option<Uuid>,
) -> Result<(), HrError> {
    sqlx::query("UPDATE lifecycle_cases SET branch_id=COALESCE($4,branch_id) WHERE org_id=$1 AND employee_id=$2 \
      AND kind='HIRE' AND effective_date=$3::date AND state='OPEN'")
        .bind(org).bind(employee).bind(on).bind(branch).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE lifecycle_cases c SET legal_entity_id=a.legal_entity_id,workplace_id=a.workplace_id,employment_id=b.employment_id, \
      branch_id=COALESCE($4,w.default_branch_id,c.branch_id) \
      FROM employment_source_bindings b,employment_assignments a LEFT JOIN workplaces w ON w.org_id=a.org_id AND w.id=a.workplace_id \
      WHERE c.org_id=$1 AND c.employee_id=$2 AND c.kind='HIRE' AND c.effective_date=$3::date \
      AND b.org_id=c.org_id AND b.employee_id=c.employee_id AND a.org_id=c.org_id AND a.employee_id=c.employee_id \
      AND a.superseded_at IS NULL AND a.valid_from<=c.effective_date AND (a.valid_to IS NULL OR c.effective_date<a.valid_to) \
      AND c.state='OPEN'")
      .bind(org).bind(employee).bind(on).bind(branch).execute(tx.as_mut()).await?;
    Ok(())
}
