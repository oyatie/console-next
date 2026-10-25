// SPDX-License-Identifier: LicenseRef-Proprietary
//! Existing effect receipts close their dossier items in the effect's transaction.
use crate::HrError;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(crate) async fn filing(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    target: (Uuid, &str, &str),
    receipt: Uuid,
    action: &str,
    reason: Option<&str>,
) -> Result<(), HrError> {
    let (event, kind, insurer) = target;
    // The same header lock serializes receipt changes with case completion and close.
    let cases: Vec<Uuid> = sqlx::query_scalar("SELECT c.id FROM lifecycle_cases c WHERE c.org_id=$1 AND c.state<>'CANCELLED' \
      AND EXISTS(SELECT 1 FROM lifecycle_case_items i JOIN filing_obligations f ON f.org_id=i.org_id AND f.id=i.filing_obligation_id \
        WHERE i.org_id=c.org_id AND i.case_id=c.id AND f.event_id=$2 AND f.filing_kind=$3 AND f.insurer=$4) ORDER BY c.id FOR UPDATE")
        .bind(org).bind(event).bind(kind).bind(insurer).fetch_all(tx.as_mut()).await?;
    if action == "UNDO" {
        let originals: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT ON(i.case_id,i.filing_obligation_id) i.id \
          FROM lifecycle_case_items i JOIN filing_obligations f ON f.org_id=i.org_id AND f.id=i.filing_obligation_id \
          WHERE i.org_id=$1 AND i.case_id=ANY($5) AND f.event_id=$2 AND f.filing_kind=$3 AND f.insurer=$4 \
          AND i.status IN ('DONE_OBSERVED','DONE_ATTESTED','NOT_APPLICABLE') ORDER BY i.case_id,i.filing_obligation_id,i.id")
            .bind(org).bind(event).bind(kind).bind(insurer).bind(&cases).fetch_all(tx.as_mut()).await?;
        sqlx::query("UPDATE lifecycle_case_items i SET status='CORRECTION_NEEDED',status_code=NULL,version=i.version+1 \
          FROM filing_obligations f WHERE i.org_id=$1 AND f.org_id=i.org_id AND f.id=i.filing_obligation_id \
          AND f.event_id=$2 AND f.filing_kind=$3 AND f.insurer=$4 AND i.case_id=ANY($5) AND i.status IN ('DONE_OBSERVED','DONE_ATTESTED')")
            .bind(org).bind(event).bind(kind).bind(insurer).bind(&cases).execute(tx.as_mut()).await?;
        for original in originals {
            sqlx::query("INSERT INTO lifecycle_case_items (org_id,case_id,item_key,source,template_item_version,label_ko,kind,venue,mode,owner_line, \
              assignee_user_id,requested_on,due_date,due_rule_ref,opens_on,opens_rule_ref,due_basis,due_disposition,status,blocks_close,legal,filing_obligation_id) \
              SELECT i.org_id,i.case_id,'AH'||(COALESCE((SELECT max(substring(n.item_key FROM 3)::int) FROM lifecycle_case_items n \
                WHERE n.org_id=i.org_id AND n.case_id=i.case_id AND n.item_key ~ '^AH[0-9]{1,3}$'),0)+1)::text, \
              'AD_HOC',NULL,COALESCE(i.label_ko,t.label_ko),'FIL',i.venue,i.mode,i.owner_line,i.assignee_user_id,i.requested_on, \
              i.due_date,i.due_rule_ref,i.opens_on,i.opens_rule_ref,i.due_basis,i.due_disposition,'OPEN',true,i.legal,i.filing_obligation_id \
              FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
              LEFT JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
              WHERE i.org_id=$1 AND i.id=$2 AND NOT EXISTS(SELECT 1 FROM lifecycle_case_items pending \
                WHERE pending.org_id=i.org_id AND pending.case_id=i.case_id AND pending.filing_obligation_id=i.filing_obligation_id \
                  AND pending.status IN ('OPEN','PENDING_TRIGGER','BLOCKED'))")
                .bind(org).bind(original).execute(tx.as_mut()).await?;
        }
        sqlx::query("UPDATE lifecycle_cases c SET state='OPEN',closed_at=NULL,close_basis=NULL,version=c.version+1 \
          WHERE c.org_id=$1 AND c.id=ANY($2) AND c.state='CLOSED' AND EXISTS(SELECT 1 FROM lifecycle_case_items i \
            WHERE i.org_id=c.org_id AND i.case_id=c.id AND i.blocks_close AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED'))")
            .bind(org).bind(&cases).execute(tx.as_mut()).await?;
    } else if matches!(action, "COMPLETE" | "NOT_APPLICABLE") {
        sqlx::query("UPDATE lifecycle_case_items i SET status=$5,status_code=$6,observed_ref=jsonb_build_object('table','insurance_filing_records','id',$7::uuid),\
          done_at=now(),version=i.version+1 FROM filing_obligations f WHERE i.org_id=$1 AND f.org_id=i.org_id AND f.id=i.filing_obligation_id \
          AND f.event_id=$2 AND f.filing_kind=$3 AND f.insurer=$4 AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED')")
            .bind(org).bind(event).bind(kind).bind(insurer).bind(if action=="COMPLETE" {"DONE_OBSERVED"}else{"NOT_APPLICABLE"})
            .bind(if action=="NOT_APPLICABLE" {reason}else{None}).bind(receipt).execute(tx.as_mut()).await?;
    }
    Ok(())
}

pub(crate) async fn access(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    case: Uuid,
    events: &mut Vec<AuditEvent>,
) -> Result<(), HrError> {
    let observed = if let Some(event) = events
        .iter()
        .find(|e| e.action.as_str() == "user.access.end_on_exit")
    {
        *event.id.as_uuid()
    } else {
        // The sweep also has a receipt when the employee has no account to end.
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("lifecycle_case.access_checked")?,
            "lifecycle_case",
            case.to_string(),
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .with_org(org);
        let id = *event.id.as_uuid();
        events.push(event);
        id
    };
    sqlx::query("UPDATE lifecycle_case_items SET status='DONE_OBSERVED',observed_ref=jsonb_build_object('table','audit_events','id',$3::uuid),\
      done_at=now(),version=version+1 WHERE org_id=$1 AND case_id=$2 AND item_key='X16' AND status IN ('OPEN','PENDING_TRIGGER','BLOCKED')")
        .bind(org.as_uuid()).bind(case).bind(observed).execute(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn request(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
    request: Uuid,
    kind: &str,
    on: time::Date,
) -> Result<(), HrError> {
    use sqlx::Row;
    let rules=sqlx::query("SELECT code,filing_rule->>'insurer' AS insurer FROM statutory_rules WHERE filing_rule->>'filing_kind'=$1 \
      AND effective_from<=$2 AND (effective_to_exclusive IS NULL OR $2<effective_to_exclusive)")
        .bind(kind).bind(on).fetch_all(tx.as_mut()).await?;
    for rule in rules {
        let insurer: String = rule.try_get("insurer")?;
        sqlx::query("INSERT INTO filing_obligations (org_id,event_id,filing_kind,insurer) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(org).bind(request).bind(kind).bind(&insurer).execute(tx.as_mut()).await?;
        if kind == "SEPARATION_CERTIFICATE" {
            sqlx::query("UPDATE lifecycle_case_items i SET status='OPEN',requested_on=$4,filing_obligation_id=f.id,due_rule_ref=$5,opens_rule_ref=$5,version=i.version+1 \
              FROM lifecycle_cases c JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id,filing_obligations f \
              WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND x.exit_lifecycle_event_id=$2 \
              AND i.item_key='X12' AND i.status='PENDING_TRIGGER' AND f.org_id=i.org_id AND f.event_id=$3 AND f.filing_kind=$6 AND f.insurer=$7")
                .bind(org).bind(event).bind(request).bind(on).bind(rule.try_get::<String,_>("code")?).bind(kind).bind(&insurer).execute(tx.as_mut()).await?;
        }
    }
    Ok(())
}
