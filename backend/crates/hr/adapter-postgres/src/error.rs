//! `HrError`: the HR context's error, carrying its HTTP status (`http` is
//! allowed in adapters; axum is not). The single `IntoResponse` lives in
//! `console-hr-rest` on `HrApiError` (backend-module-map §1.4), so the wire is
//! byte-identical to the pre-move `hr.rs` (pinned by `error_wire_pins`).

use console_kernel_core::{ErrorKind, KernelError};
use console_leave_adapter_postgres::PgLeaveError;
use console_ontology_canonical_adapter_postgres::employment;
use console_ontology_canonical_adapter_postgres::person::PersonError;
use console_platform_db::DbError;
use http::StatusCode;
use serde_json::Value;

#[derive(Debug)]
pub struct HrError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub errors: Option<Vec<FieldError>>,
    /// Per-item refusals of an all-or-nothing batch (`error.refusals`).
    /// Boxed so the shared error stays small on every command's return path.
    pub refusals: Option<Box<Value>>,
}

#[derive(Debug, serde::Serialize)]
pub struct FieldError {
    pub field: String,
    pub code: &'static str,
}

impl HrError {
    pub fn from_kernel(error: KernelError) -> Self {
        let status =
            StatusCode::from_u16(error.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let code = error.code.unwrap_or_else(|| error.kind.code());
        Self {
            status,
            code,
            message: error.message,
            errors: error.field.map(|field| vec![FieldError { field, code }]),
            refusals: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::validation(message.into()))
    }

    /// 422 `lifecycle_signoff_required`: the named ack is missing for the event.
    pub fn signoff_required(ack: &str, event_type: &str) -> Self {
        Self {
            errors: None,
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "lifecycle_signoff_required",
            message: format!("{ack} is required for {event_type}"),
            refusals: None,
        }
    }

    /// 422 `bulk_lifecycle_refused`: some employees in an all-or-nothing batch
    /// cannot take the change; nothing was written. `refusals` names each one.
    pub fn bulk_refused(refusals: Vec<Value>, requested: usize) -> Self {
        Self {
            errors: None,
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "bulk_lifecycle_refused",
            message: format!(
                "{} of {requested} employees cannot take this change; nothing was recorded",
                refusals.len()
            ),
            refusals: Some(Box::new(Value::Array(refusals))),
        }
    }

    /// 409 `lifecycle_schedule_conflict`: the change would make the
    /// employee's later SCHEDULED events fail on their dates; nothing was
    /// written. `refusals` names each event and why.
    pub fn schedule_conflict(refusals: Vec<Value>) -> Self {
        Self {
            errors: None,
            status: StatusCode::CONFLICT,
            code: "lifecycle_schedule_conflict",
            message: format!(
                "{} scheduled lifecycle events would no longer apply after this change; cancel or change them first",
                refusals.len()
            ),
            refusals: Some(Box::new(Value::Array(refusals))),
        }
    }

    /// 409 `lifecycle_scheduled_state`: on the event's date the employee will
    /// stand in `status` because of an earlier scheduled event.
    pub fn scheduled_state(status: &str, date: &str, event_type: &str) -> Self {
        Self {
            errors: None,
            status: StatusCode::CONFLICT,
            code: "lifecycle_scheduled_state",
            message: format!(
                "the employee will be {status} from {date} by the scheduled {event_type}"
            ),
            refusals: None,
        }
    }

    /// 422 `lifecycle_noop`: the event would change nothing.
    pub fn lifecycle_noop(event_type: &str) -> Self {
        Self {
            errors: None,
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "lifecycle_noop",
            message: format!("{event_type} would not change the employee"),
            refusals: None,
        }
    }

    pub fn workbook(message: impl Into<String>) -> Self {
        Self {
            errors: None,
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "workbook",
            message: message.into(),
            refusals: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            errors: None,
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
            refusals: None,
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            errors: None,
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: message.into(),
            refusals: None,
        }
    }

    pub fn from_leave_store(error: PgLeaveError) -> Self {
        match error {
            PgLeaveError::CommandUnavailable => Self::unavailable(
                "leave command database is not configured; protected employee leave changes are unavailable",
            ),
            PgLeaveError::Domain(error) => Self::from_kernel(error),
            PgLeaveError::ConcurrentModification => Self::from_kernel(KernelError::conflict(
                "employee changed since it was read; reload before retrying the protected leave change",
            )),
            PgLeaveError::Db(error) => Self::from(error),
            PgLeaveError::MissingHomeBranch | PgLeaveError::ChargeReviewRequired(_) => {
                tracing::error!(error = ?error, "unexpected protected employee leave command result");
                Self::internal("protected employee leave change failed")
            }
        }
    }
}

impl From<KernelError> for HrError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

/// MR-28: the tenant-unique 사번 index (0277). Every writer that reaches it
/// (registration, import apply, a 정정) answers 409, never 500.
const EMPLOYEE_NUMBER_INDEX: &str = "employees_org_employee_number_key";

impl From<DbError> for HrError {
    fn from(value: DbError) -> Self {
        if let DbError::Sqlx(sqlx::Error::Database(db)) = &value
            && db.constraint() == Some(EMPLOYEE_NUMBER_INDEX)
        {
            return Self {
                errors: None,
                status: StatusCode::CONFLICT,
                code: "employee_number_taken",
                message: "another employee, or a cancelled registration, already holds this employee number".into(),
                refusals: None,
            };
        }
        // Pool and connection failures are overload, not application faults (decisions #28).
        if matches!(value, DbError::Unavailable(_)) {
            return Self {
                errors: None,
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "unavailable",
                message: "service temporarily unavailable".into(),
                refusals: None,
            };
        }
        tracing::error!(error = ?value, "employee directory database operation failed");
        Self::internal("employee directory request failed")
    }
}

impl From<sqlx::Error> for HrError {
    fn from(value: sqlx::Error) -> Self {
        HrError::from(DbError::from(value))
    }
}

impl From<PersonError> for HrError {
    fn from(error: PersonError) -> Self {
        match error {
            PersonError::Blocked(blockers) => Self::from_kernel(KernelError::validation(format!(
                "preflight blocked the command: {blockers:?}"
            ))),
            PersonError::DigestConflict(id) => Self::from_kernel(KernelError::conflict(format!(
                "command {id} was already applied with a different payload"
            ))),
            PersonError::Database(error) => Self::from(error),
            PersonError::UnreadableReceipt(id, message) => {
                tracing::error!(command = %id, receipt = %message, "person command receipt unreadable");
                Self::internal("employee directory request failed")
            }
        }
    }
}

impl From<employment::EmploymentError> for HrError {
    fn from(error: employment::EmploymentError) -> Self {
        match error {
            // §3.9.1 freeze refusal (Conflict) and unparseable date (Validation)
            // carry client-safe, actionable messages and pass through unchanged.
            // A gate failure (Internal) carries raw driver diagnostics that must
            // be logged, not returned, per the kernel error contract.
            employment::EmploymentError::Frozen(error) => match error.kind {
                ErrorKind::Internal => {
                    tracing::error!(error = %error.message, "employment freeze gate failed");
                    Self::internal("employment change could not be applied")
                }
                _ => Self::from_kernel(error),
            },
            // Preserve the exact driver-error mapping (and its trace log).
            employment::EmploymentError::Database(error) => Self::from(error),
            employment::EmploymentError::UnknownOrgUnit(id) => {
                Self::from_kernel(KernelError::validation(format!(
                    "org_unit_id {id} is not a known OrgUnit in this tenant"
                )))
            }
            employment::EmploymentError::UnknownJobPosition(id) => {
                Self::from_kernel(KernelError::validation(format!(
                    "job_position_id {id} is not a known JobPosition in this tenant"
                )))
            }
            employment::EmploymentError::OrgUnitRefNotUuid => {
                Self::from_kernel(KernelError::validation(
                    "fromOrgUnit/toOrgUnit must be OrgUnit UUIDs, not free-text team labels"
                        .to_owned(),
                ))
            }
            // Port-level refusals other than the directory UUID refs surface
            // through the ontology dispatcher. Mapped as internal so a future
            // variant fails loud rather than as a wrong HTTP status.
            other => Self::from_kernel(KernelError::internal(other.to_string())),
        }
    }
}
