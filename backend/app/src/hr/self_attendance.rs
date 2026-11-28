// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_settings_domain::{SettingKey, SettingValue};

async fn console_clock_out(
    tx: &mut sqlx::PgConnection,
    org: OrgId,
    employee: Uuid,
) -> Result<bool, HrError> {
    let key = SettingKey::AttendanceConsoleClockOut;
    let settings = match console_settings_adapter_postgres::resolve_in_tx(
        tx,
        org,
        &[key],
        Some(employee),
        OffsetDateTime::now_utc(),
    )
    .await
    {
        Ok(settings) => settings,
        Err(error) if error.code == Some("setting_scope_unknown") => return Ok(false),
        Err(error) => return Err(HrError::from_kernel(error)),
    };
    match settings.get(&key) {
        Some(Ok(console_kernel_core::Resolved {
            value: SettingValue::Bool(enabled),
            ..
        })) => Ok(*enabled),
        _ => Err(HrError::internal("console clock-out policy unavailable")),
    }
}

pub(super) async fn list_my_attendance_records(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceSelfRecordsQuery>,
) -> Result<Json<EmployeeAttendanceRecordPage>, HrApiError> {
    record_hr_read("employee_attendance_self");
    let org = principal.org_id;
    let user_id = principal.user_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let page = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            // Self-scoped read, no role gate: an authenticated user with no
            // linked employee — an ADMIN/system account — has zero personal
            // records, so return an empty page rather than a 403. (Writes still
            // require a link via `attendance_access::linked_employee`.)
            match load_optional_linked_employee_id(tx, org, user_id).await? {
                Some(employee_id) => {
                    let mut page =
                        list_attendance_records_for_employee(tx, employee_id, None, limit, offset)
                            .await?;
                    page.console_clock_out = Some(console_clock_out(tx, org, employee_id).await?);
                    Ok(page)
                }
                None => Ok(EmployeeAttendanceRecordPage {
                    console_clock_out: Some(false),
                    items: Vec::new(),
                    total: 0,
                    limit,
                    offset,
                }),
            }
        })
    })
    .await?;

    Ok(Json(page))
}

pub(super) async fn create_my_attendance_record(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateEmployeeAttendanceRecordRequest>,
) -> Result<Json<EmployeeAttendanceRecordResponse>, HrApiError> {
    let org = principal.org_id;
    let actor = principal.user_id;
    let kind = normalize_attendance_kind(&body.kind)?;
    let idempotency_key = normalize_idempotency_key(body.idempotency_key)?;
    let note = normalize_attendance_note(body.note)?;

    let response = with_audits::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let linked = attendance_access::linked_employee(tx, org, actor).await?;

            if let Some(existing) =
                load_attendance_record_by_idempotency_key(tx, linked.employee_id, &idempotency_key)
                    .await?
            {
                if existing.kind.as_str() != kind || existing.note != note {
                    return Err(HrError::from_kernel(KernelError::conflict(
                        "idempotency key already used with different attendance payload",
                    )));
                }
                return Ok((existing, Vec::new()));
            }

            if kind == "CLOCK_OUT" && !console_clock_out(tx, org, linked.employee_id).await? {
                return Err(HrError::from_kernel(
                    KernelError::forbidden("console clock-out is disabled for this employee")
                        .with_code("attendance.refuse.console_clock_out_disabled"),
                ));
            }

            let previous_state: Option<String> = sqlx::query_scalar(
                r#"
                SELECT state_after
                FROM employee_attendance_records
                WHERE employee_id = $1
                ORDER BY occurred_at DESC, created_at DESC, id DESC
                LIMIT 1
                "#,
            )
            .bind(linked.employee_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let state_after = next_employee_attendance_state(previous_state.as_deref(), kind)?;

            let record_row = sqlx::query(
                r#"
                INSERT INTO employee_attendance_records (
                    org_id,
                    employee_id,
                    actor_user_id,
                    kind,
                    state_after,
                    note,
                    idempotency_key
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING
                    id,
                    employee_id,
                    kind,
                    occurred_at,
                    work_date::TEXT AS work_date,
                    state_after,
                    note
                "#,
            )
            .bind(*org.as_uuid())
            .bind(linked.employee_id)
            .bind(*actor.as_uuid())
            .bind(kind)
            .bind(state_after)
            .bind(note)
            .bind(&idempotency_key)
            .fetch_one(tx.as_mut())
            .await?;

            let record_id: Uuid = record_row.try_get("id")?;
            let work_date: String = record_row.try_get("work_date")?;
            let digest = sha256_hex(
                format!(
                    "employee_self_service|{}|{}|{}|{}",
                    org.as_uuid(),
                    linked.employee_id,
                    record_id,
                    kind
                )
                .as_bytes(),
            );

            // Freeze-window gate: an attendance write that stamps a work_date
            // inside a locked payroll period must fail closed (rolls back the
            // whole attendance record + material-ref transaction, 409).
            let work_date_parsed = Date::parse(
                &work_date,
                &time::format_description::well_known::Iso8601::DATE,
            )
            .map_err(|e| {
                HrError::from_kernel(KernelError::internal(format!(
                    "attendance work_date unparseable: {e}"
                )))
            })?;
            console_platform_db::assert_employee_payroll_period_open(
                tx,
                *org.as_uuid(),
                linked.employee_id,
                work_date_parsed,
            )
            .await
            .map_err(HrError::from_kernel)?;

            let ref_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payroll_attendance_material_refs (
                    org_id,
                    attendance_record_id,
                    employee_id,
                    work_date,
                    source_digest
                )
                VALUES ($1, $2, $3, $4::DATE, $5)
                RETURNING id
                "#,
            )
            .bind(*org.as_uuid())
            .bind(record_id)
            .bind(linked.employee_id)
            .bind(&work_date)
            .bind(digest)
            .fetch_one(tx.as_mut())
            .await?;

            let response = employee_attendance_record_from_parts(
                record_row,
                linked.display_name,
                ref_id,
                false,
            )?;

            let attendance_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("employee_attendance.record").map_err(HrError::from_kernel)?,
                "employee_attendance_record",
                record_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "employee_id": linked.employee_id,
                    "kind": response.kind,
                    "state_after": response.state_after,
                    "work_date": response.work_date,
                    "payroll_material_ref_id": ref_id,
                })),
            );
            let payroll_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("payroll_attendance.link").map_err(HrError::from_kernel)?,
                "payroll_attendance_material_ref",
                ref_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "attendance_record_id": record_id,
                    "employee_id": linked.employee_id,
                    "work_date": response.work_date,
                    "source_type": "employee_self_service",
                })),
            );

            Ok((response, vec![attendance_audit, payroll_audit]))
        })
    })
    .await?;

    Ok(Json(response))
}
