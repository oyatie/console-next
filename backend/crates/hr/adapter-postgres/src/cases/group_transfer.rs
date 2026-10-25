// SPDX-License-Identifier: LicenseRef-Proprietary
//! A 전적 links the sending employer's exit and receiving employer's hire in its transaction.

use crate::HrError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(crate) async fn link(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
    settlement: Option<Uuid>,
) -> Result<(), HrError> {
    let sending = if let Some(case) = settlement {
        super::open::exit(tx, org, case).await?;
        case
    } else {
        sqlx::query(
            "INSERT INTO lifecycle_cases (org_id,kind,variant,subject_kind,employee_id,employment_id,branch_id, \
             legal_entity_id,workplace_id,org_unit_id,trigger_kind,trigger_id,effective_date,template_key,template_version,opened_by) \
             SELECT l.org_id,'EXIT','GROUP_TRANSFER','EMPLOYMENT',l.employee_id,b.employment_id, \
               COALESCE(w.default_branch_id,e.home_branch_id),g.from_legal_entity_id,a.workplace_id,l.from_org_unit_id, \
               'LIFECYCLE_EVENT',l.id,l.effective_date::date-1,t.template_key,t.version,l.created_by \
             FROM employee_lifecycle_events l JOIN employee_group_transfers g ON g.org_id=l.org_id AND g.lifecycle_event_id=l.id \
             JOIN person_employees_current e ON e.org_id=l.org_id AND e.id=l.employee_id \
             LEFT JOIN employment_source_bindings b ON b.org_id=l.org_id AND b.employee_id=l.employee_id \
             LEFT JOIN LATERAL (SELECT a.workplace_id FROM employment_assignments a \
               WHERE a.org_id=l.org_id AND a.employee_id=l.employee_id AND a.superseded_at IS NULL \
                 AND a.valid_from<l.effective_date::date ORDER BY a.valid_from DESC LIMIT 1) a ON true \
             LEFT JOIN workplaces w ON w.org_id=l.org_id AND w.id=a.workplace_id \
             JOIN LATERAL (SELECT * FROM case_templates WHERE template_key='EXIT' \
               AND effective_from<=l.effective_date::date-1 \
               AND (effective_to_exclusive IS NULL OR l.effective_date::date-1<effective_to_exclusive) \
               ORDER BY effective_from DESC LIMIT 1) t ON true \
             WHERE l.org_id=$1 AND l.id=$2 AND l.event_type='GROUP_TRANSFER' ON CONFLICT DO NOTHING",
        )
        .bind(org)
        .bind(event)
        .execute(tx.as_mut())
        .await?;
        sqlx::query_scalar(
            "SELECT id FROM lifecycle_cases WHERE org_id=$1 AND trigger_kind='LIFECYCLE_EVENT' \
             AND trigger_id=$2 AND kind='EXIT'",
        )
        .bind(org)
        .bind(event)
        .fetch_one(tx.as_mut())
        .await?
    };

    // Both scheduled and immediate actions retain each employer's own placement.
    sqlx::query(
        "UPDATE lifecycle_cases c SET legal_entity_id=g.from_legal_entity_id,workplace_id=a.workplace_id \
         FROM employee_group_transfers g JOIN LATERAL (SELECT a.workplace_id FROM employment_assignments a \
           WHERE a.org_id=g.org_id AND a.employee_id=g.employee_id AND a.superseded_at IS NULL \
             AND a.valid_from<g.start_date ORDER BY a.valid_from DESC LIMIT 1) a ON true \
         WHERE c.org_id=$1 AND c.id=$3 AND g.org_id=c.org_id AND g.lifecycle_event_id=$2",
    )
    .bind(org)
    .bind(event)
    .bind(sending)
    .execute(tx.as_mut())
    .await?;
    let receiving: Uuid = sqlx::query_scalar(
        "UPDATE lifecycle_cases c SET legal_entity_id=g.to_legal_entity_id,workplace_id=g.to_workplace_id, \
           branch_id=COALESCE((SELECT w.default_branch_id FROM workplaces w WHERE w.org_id=g.org_id AND w.id=g.to_workplace_id),c.branch_id) \
         FROM employee_group_transfers g WHERE c.org_id=$1 AND c.trigger_id=$2 AND c.kind='HIRE' \
           AND g.org_id=c.org_id AND g.lifecycle_event_id=$2 RETURNING c.id",
    )
    .bind(org)
    .bind(event)
    .fetch_one(tx.as_mut())
    .await?;
    super::open::items(tx, org, sending).await?;
    super::open::initialise(tx, org, sending).await?;
    super::open::initialise(tx, org, receiving).await?;
    observe(tx, org, sending).await?;
    for (case, linked) in [(sending, receiving), (receiving, sending)] {
        sqlx::query(
            "UPDATE lifecycle_cases SET linked_case_id=$3,version=version+1 \
             WHERE org_id=$1 AND id=$2 AND linked_case_id IS DISTINCT FROM $3",
        )
        .bind(org)
        .bind(case)
        .bind(linked)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

pub(crate) async fn observe(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
) -> Result<(), HrError> {
    sqlx::query(
        "UPDATE lifecycle_case_items i SET status='DONE_OBSERVED',status_code=NULL,done_at=now(),version=i.version+1, \
           observed_ref=jsonb_build_object('table','employee_group_transfers','id',g.lifecycle_event_id, \
             'consent_date',g.consent_date,'consent_evidence_ref',g.consent_evidence_ref, \
             'succession_evidence_ref',g.succession_evidence_ref) \
         FROM lifecycle_cases c LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
         JOIN employee_group_transfers g ON g.org_id=c.org_id AND g.lifecycle_event_id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) \
         WHERE i.org_id=$1 AND c.org_id=i.org_id AND c.id=i.case_id AND c.id=$2 AND c.state='OPEN' \
           AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED') \
           AND ((i.item_key='GT2' AND i.kind='REC') \
             OR (i.item_key='GT1' AND i.kind='DOC' AND g.consent_date IS NOT NULL \
               AND NULLIF(btrim(g.consent_evidence_ref),'') IS NOT NULL) \
             OR (i.item_key='GT3' AND i.kind='PAY' AND g.continuity='CARRIED' \
               AND NULLIF(btrim(g.succession_evidence_ref),'') IS NOT NULL))",
    )
    .bind(org)
    .bind(case)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
