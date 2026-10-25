//! Employee-binding checks shared by employee creation and lifecycle transfers.

use console_hr_domain::profile::enums::EmploymentType;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_leave_adapter_postgres::PgLeaveStore;
use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use console_ontology_canonical_adapter_postgres::employment;
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use http::StatusCode;
use sqlx::{PgPool, Postgres};
use uuid::Uuid;

use crate::authz::{authorize_hr_place, hr_reach};
use crate::digest::sha256_hex;
use crate::directory::audit::employee_create_audit;
use crate::directory::create_checks::{
    employee_number_taken, registration_checks, same_name_same_hire_date_warning,
};
use crate::directory::create_core::create_employee_core;
use crate::directory::create_exception::record_duplicate_exception;
use crate::directory::create_facts::minimum_wage_warning;
use crate::directory::create_guard::registration_key_reused;
use crate::directory::create_placement::place_registration;
use crate::directory::home_branch::assign_home_branch_if_unset;
use crate::directory::normalize::normalize_create_employee_request;
use crate::directory::types::{
    CreateEmployeeRequest, EmployeeCreateWarning, EmployeeDetailResponse,
    NormalizedCreateEmployeeRequest,
};
use crate::{HrError, HrService};

/// The unit name for an employee binding, or the refusal: 404 when the unit is
/// not visible in this tenant (foreign or missing), 422 when it exists but is
/// dissolved or not a Site/Department/Team.
pub async fn require_assignable_org_unit(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    org_unit_id: Uuid,
) -> Result<String, HrError> {
    if let Some(name) = employment::assignable_org_unit_name(tx, org_uuid, org_unit_id).await? {
        return Ok(name);
    }
    if employment::ensure_org_unit_exists(tx, org_uuid, org_unit_id)
        .await
        .is_ok()
    {
        return Err(HrError::validation(
            "org_unit_id must be an ACTIVE site, department, or team",
        ));
    }
    Err(HrError::from_kernel(KernelError::not_found(
        "org unit was not found in this organization",
    )))
}

/// BW-19 3: the two unique-violation causes of a create get their own codes:
/// the idempotency reservation's constraint is `idempotency_key_reused`; the
/// 사번 uniqueness (the 0183 trigger, which names no constraint) is
/// `employee_number_taken`. The pre-write check names the holder; this mapping
/// covers the race it cannot see.
pub fn employee_create_db_error(error: sqlx::Error) -> HrError {
    if let Some(database) = error.as_database_error()
        && database.code().is_some_and(|code| code == "23505")
    {
        return if database
            .constraint()
            .is_some_and(|name| name.contains("idempotency"))
        {
            registration_key_reused()
        } else {
            employee_number_taken(None)
        };
    }
    HrError::from(error)
}

/// The next server-assigned employee number: `E-` and a zero-padded per-tenant
/// sequence (`E-000001`, `E-000002`, …), one past the highest number of that
/// shape in the tenant (a manual number of the same shape moves the sequence
/// past it, so the two never collide). A per-tenant advisory lock held to
/// commit serializes concurrent assignments.
pub async fn next_employee_number(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
) -> Result<String, HrError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('employee_number_seq:' || $1::text))")
        .bind(org_uuid)
        .execute(tx.as_mut())
        .await?;
    // A voided registration keeps its 사번 (MR-26), so it counts here too, and
    // so does every number a 사번 변경 ever moved away from or to (records-02:
    // a retired E-000001 alias was issued again and refused 409).
    include_voided(tx, true).await?;
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT max(substr(n, 3)::BIGINT) FROM ( \
           SELECT employee_number AS n FROM employees WHERE org_id = $1 \
           UNION ALL SELECT from_number FROM employee_number_changes WHERE org_id = $1 \
           UNION ALL SELECT to_number FROM employee_number_changes WHERE org_id = $1) used \
         WHERE n ~ '^E-[0-9]{6,18}$'",
    )
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;
    include_voided(tx, false).await?;
    Ok(format!("E-{:06}", last.unwrap_or(0) + 1))
}

/// Other non-exited employees bound to `org_unit_id` with exactly this name.
pub async fn same_name_in_unit_warning(
    pool: &PgPool,
    org: OrgId,
    employee_id: Uuid,
    name: &str,
    org_unit_id: Option<Uuid>,
) -> Result<Vec<EmployeeCreateWarning>, HrError> {
    let name = name.to_owned();
    with_org_conn::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            super::read_warnings::same_name_in_unit(
                tx,
                *org.as_uuid(),
                employee_id,
                &name,
                org_unit_id,
            )
            .await
        })
    })
    .await
}

/// The registration transaction of `POST /api/v1/employees` (everything but
/// the audit row and the post-commit home-branch routing): the BW-19 checks,
/// the core write, the duplicate-override exception and the same-day warning.
/// Returns the employee, whether this was a replay, and the warning.
pub async fn register_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    request: &NormalizedCreateEmployeeRequest,
    employee_id: Uuid,
) -> Result<(EmployeeDetailResponse, bool, Option<EmployeeCreateWarning>), HrError> {
    let org_uuid = *org.as_uuid();
    let request_hash = sha256_hex(
        serde_json::to_string(request)
            .map_err(|_| HrError::validation("employee request could not be serialized"))?
            .as_bytes(),
    );
    let duplicate_override = registration_checks(tx, org_uuid, request).await?;
    let (detail, replayed) =
        create_employee_core(tx, org_uuid, actor, request, &request_hash, employee_id).await?;
    if !replayed && let Some(given) = duplicate_override.as_ref() {
        record_duplicate_exception(tx, org, actor, detail.employee_id(), given).await?;
    }
    if !replayed {
        place_registration(
            tx,
            org_uuid,
            *actor.as_uuid(),
            detail.employee_id(),
            request,
        )
        .await?;
        crate::cases::open::place(
            tx,
            org_uuid,
            detail.employee_id(),
            request.hire_date.as_deref(),
            request.home_branch_id,
        )
        .await?;
    }
    let warning = same_name_same_hire_date_warning(
        tx,
        org_uuid,
        detail.employee_id(),
        &request.name,
        request.hire_date.as_deref(),
    )
    .await?;
    Ok((detail, replayed, warning))
}

impl HrService {
    pub async fn create_employee(
        &self,
        principal: Principal,
        command_store: PgLeaveStore,
        body: CreateEmployeeRequest,
    ) -> Result<(StatusCode, EmployeeDetailResponse), HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        if body
            .hire_date
            .as_deref()
            .is_none_or(|v| v.trim().is_empty())
        {
            return Err(HrError::validation("hire_date is required"));
        }
        let request = normalize_create_employee_request(body)?;
        let org = principal.org_id;
        let actor = principal.user_id;
        let employee_id = Uuid::new_v4();
        let home_branch_id = request.home_branch_id;
        let kind = request
            .employment_type
            .as_deref()
            .map(EmploymentType::parse)
            .transpose()?;
        let facts = request.facts.clone();
        let hire_date = request
            .hire_date
            .as_deref()
            .map(parse_yyyy_mm_dd)
            .transpose()?;

        // The `employees` row is written through `ObjectKey::Employment`'s owner (the
        // canonical adapter), NOT through the leave command capability, so
        // `console_leave_definer` no longer INSERTs into `employees` for People &
        // Workforce creation. The first home-branch routing authority is established
        // post-commit by [`assign_home_branch_if_unset`], exactly like the recruiting
        // hire handshake.
        let (created, replayed, hire_warning) =
            with_audits::<_, _, HrError>(&self.pool, org, |tx| {
                Box::pin(async move {
                    // AX-5: the place registered into, inside the grant set.
                    let place = (
                        request.legal_entity_id,
                        request.workplace_id,
                        request.org_unit_id,
                    );
                    let manage = Feature::EmployeeDirectoryManage;
                    authorize_hr_place(tx, &principal, manage, place).await?;
                    let (detail, replayed, warning) =
                        register_in_tx(tx, org, actor, &request, employee_id).await?;
                    let audits = if replayed {
                        Vec::new()
                    } else {
                        vec![employee_create_audit(org, actor, &request, &detail)?]
                    };
                    Ok(((detail, replayed, warning), audits))
                })
            })
            .await?;

        let employee_id = created.employee_id();
        let mut detail = if let Some(home_branch_id) = home_branch_id {
            assign_home_branch_if_unset(
                &self.pool,
                &command_store,
                org,
                employee_id,
                home_branch_id,
                actor,
                replayed,
            )
            .await?
        } else {
            created
        };
        detail.warnings = same_name_in_unit_warning(
            &self.pool,
            org,
            employee_id,
            &detail.employee.name,
            detail.employee.org_unit_id,
        )
        .await?;
        detail.warnings.extend(hire_warning);
        detail
            .warnings
            .extend(kind.and_then(|kind| minimum_wage_warning(kind, &facts, hire_date)));
        Ok((
            if replayed {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            },
            detail,
        ))
    }
}
