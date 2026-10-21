//! Setup 부서 코드 and 부서장 (G5, D19). They live in the unit's revision
//! attributes under the keys the org change's `SET_ORG_UNIT_DETAILS` writes
//! (`code`, `head_employee_id`, `head_since`), so one read serves both
//! phases. `head_since` dates the head: it moves only when the head changes.

use console_entity_domain::structure_code::structure_code;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::org_batch::Run;
use crate::{PgEntityError, Tx};

/// Validate `code` and `head` (the full new values; `None` clears) and write
/// them into `attributes`.
pub(crate) async fn set(
    tx: &mut Tx<'_>,
    run: &Run<'_>,
    i: usize,
    unit: Option<Uuid>,
    attributes: &mut Value,
    code: Option<&str>,
    head: Option<Uuid>,
) -> Result<(), PgEntityError> {
    let code = structure_code(&run.field(i, "code"), code)?;
    if let Some(code) = &code
        && code_taken(tx, code, unit).await?
    {
        return Err(run.refuse(i, "code", "code_taken"));
    }
    match code {
        Some(code) => attributes["code"] = json!(code),
        None => remove(attributes, "code"),
    }
    let Some(head) = head else {
        remove(attributes, "head_employee_id");
        remove(attributes, "head_since");
        return Ok(());
    };
    if attributes["head_employee_id"] != json!(head.to_string()) {
        if !head_available(tx, head).await? {
            return Err(run.refuse(i, "head_employee_id", "head_unavailable"));
        }
        attributes["head_employee_id"] = json!(head.to_string());
        attributes["head_since"] = json!(run.today.to_string());
    }
    Ok(())
}

fn remove(attributes: &mut Value, key: &str) {
    if let Some(bag) = attributes.as_object_mut() {
        bag.remove(key);
    }
}

/// Another active unit already has `code` (exact match).
async fn code_taken(
    tx: &mut Tx<'_>,
    code: &str,
    except: Option<Uuid>,
) -> Result<bool, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
           FROM org_unit_revisions ORDER BY org_unit_id, version DESC) h \
         WHERE h.attributes->>'code' = $1 AND h.attributes->>'status' IS DISTINCT FROM 'dissolved' \
           AND h.org_unit_id IS DISTINCT FROM $2)",
    )
    .bind(code)
    .bind(except)
    .fetch_one(tx.as_mut())
    .await?)
}

/// The employee exists and has not left.
async fn head_available(tx: &mut Tx<'_>, employee: Uuid) -> Result<bool, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employees WHERE id = $1 AND employment_status <> 'EXITED')",
    )
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?)
}
