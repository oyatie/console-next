// SPDX-License-Identifier: LicenseRef-Proprietary
//! Hire checklist entries observe the same facts as the existing onboarding read.
use crate::HrError;
use console_hr_domain::checklist::ItemState;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) async fn observe(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
) -> Result<(), HrError> {
    let employee: Option<Uuid> = sqlx::query_scalar("SELECT c.employee_id FROM lifecycle_cases c WHERE c.org_id=$1 AND c.id=$2 AND c.kind='HIRE' AND c.state='OPEN' AND EXISTS(SELECT 1 FROM lifecycle_case_items i JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key WHERE i.org_id=c.org_id AND i.case_id=c.id AND t.checklist_item IS NOT NULL AND i.status='OPEN')")
        .bind(org).bind(case).fetch_optional(tx.as_mut()).await?;
    let Some(employee) = employee else {
        return Ok(());
    };
    let mut observations = Vec::new();
    for (entry, reference) in crate::checklist::observed_checklist(tx, org, employee).await? {
        if entry.state != ItemState::Done || reference.is_none() {
            continue;
        }
        let key = serde_json::to_value(entry.item)
            .map_err(|error| HrError::internal(error.to_string()))?;
        observations.push(serde_json::json!({"key":key,"reference":reference}));
    }
    sqlx::query("UPDATE lifecycle_case_items i SET status='DONE_OBSERVED',observed_ref=r.reference,done_at=now(),version=i.version+1 \
      FROM jsonb_to_recordset($3) r(key text,reference jsonb),lifecycle_cases c,case_template_items t \
      WHERE i.org_id=$1 AND i.case_id=$2 AND c.org_id=i.org_id AND c.id=i.case_id AND t.template_key=c.template_key \
      AND t.version=c.template_version AND t.item_key=i.item_key AND t.checklist_item=r.key AND i.status='OPEN'")
        .bind(org).bind(case).bind(serde_json::Value::Array(observations)).execute(tx.as_mut()).await?;
    Ok(())
}
