// SPDX-License-Identifier: LicenseRef-Proprietary
//! Identity-type status enforcement and `IdRegistered` audit emission for employee corrections.

use console_hr_domain::profile::enums::IdType;
use console_hr_domain::profile::identity::validate_id_type_for_status;
use console_kernel_core::{TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::id_registered::{
    IdRegisteredWrite, emit_id_registered_if_transitioned,
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::head::LockedEmployee;
use super::write::{FieldValue, value_of};
use crate::HrError;

/// Reject `id_type = NOT_ISSUED` when the employee's status is not `PRE_HIRE`.
pub(super) fn check_id_type_for_status(
    head: &LockedEmployee,
    fields: &[FieldValue],
) -> Result<(), HrError> {
    if let Some(Some(id_type_str)) = value_of(fields, "id_type")
        && let Ok(parsed) = IdType::parse(id_type_str)
    {
        validate_id_type_for_status(Some(parsed), &head.employment_status).map_err(|_| {
            HrError::validation(
                "id_type NOT_ISSUED is only allowed when employment_status is PRE_HIRE",
            )
        })?;
    }
    Ok(())
}

/// Emit `employee.id_registered` (`IdRegistered`) when `id_type` transitions out of `NOT_ISSUED`.
pub(super) async fn emit_if_id_registered(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    actor: Uuid,
    head: &LockedEmployee,
    fields: &[FieldValue],
) -> Result<(), HrError> {
    if let Some(Some(new_id_type)) = value_of(fields, "id_type") {
        emit_id_registered_if_transitioned(
            tx,
            head.id_type.as_deref(),
            IdRegisteredWrite {
                org_id: org,
                employee_id,
                actor: Some(UserId::from_uuid(actor)),
                new_id_type,
                source: "CORRECTION",
                trace: TraceContext::generate(),
            },
        )
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    }
    Ok(())
}
