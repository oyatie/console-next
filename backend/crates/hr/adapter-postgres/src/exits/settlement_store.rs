//! The settlement package upsert (moved from `app/src/hr.rs`, R2-exits).

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_payroll_domain::severance_window::completes_service_years;
use serde_json::json;
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::exits::payloads::{build_insurance_loss_payload, exit_statutory_basis};
use crate::exits::settlement::{build_settlement_calculation, with_ordinary_wage_basis};
use crate::exits::store::load_exit_case_context;
use crate::exits::types::ExitSettlementInput;

pub async fn upsert_exit_settlement_package(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    case_id: Uuid,
    settlement_input: Option<ExitSettlementInput>,
) -> Result<Uuid, HrError> {
    let context = load_exit_case_context(tx, org_uuid, case_id, false).await?;
    let exit = parse_yyyy_mm_dd(&context.effective_exit_date)?;
    let rule = crate::legal_rules::rule(
        tx.as_mut(),
        console_compliance_domain::statutory::codes::SEVERANCE_MIN_SERVICE_YEARS,
        exit,
    )
    .await?;
    let years = rule
        .whole("YEARS")
        .filter(|years| *years > 0)
        .and_then(|years| i32::try_from(years).ok());
    let under_service = match (context.hire_date.as_deref(), years) {
        (Some(hire), Some(years)) => {
            !completes_service_years(parse_yyyy_mm_dd(hire)?, exit, years)?
        }
        _ => false,
    };
    let (
        package_status,
        service_days,
        period_start,
        period_end,
        calendar_days,
        total_won,
        daily_milliwon,
        severance_pay_won,
        missing_source_fields,
        monthly_ordinary_wage_won,
        ordinary_daily_wage_won,
        statutory_daily_wage_milliwon,
    ) = build_settlement_calculation(&context, settlement_input.as_ref(), years)?;
    let mut statutory_basis = exit_statutory_basis();
    if under_service {
        statutory_basis["severance_eligibility"] = json!({
            "outcome": "NOT_ELIGIBLE", "reason": "UNDER_SERVICE_YEARS",
            "threshold": {"num": years, "den": 1}, "rule": rule,
            "as_of": exit.to_string(), "review_required": true,
        });
        let event = AuditEvent::new(
            None,
            AuditAction::new("employee.exit.severance_eligibility")?,
            "employee_exit_case",
            case_id.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(OrgId::from_uuid(org_uuid))
        .with_snapshots(None, Some(statutory_basis["severance_eligibility"].clone()));
        console_platform_db::insert_audit_event(tx, &event).await?;
    }

    let insurance_loss_payload = with_ordinary_wage_basis(
        build_insurance_loss_payload(&context),
        monthly_ordinary_wage_won,
        ordinary_daily_wage_won,
        statutory_daily_wage_milliwon,
    );

    let package_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO employee_exit_settlement_packages (
            org_id, exit_case_id, employee_id, status, service_days,
            average_wage_period_start, average_wage_period_end,
            average_wage_calendar_days, average_wage_total_won,
            average_daily_wage_milliwon, severance_pay_won,
            missing_source_fields, statutory_basis, insurance_loss_payload,
            monthly_ordinary_wage_won, ordinary_daily_wage_won,
            statutory_daily_wage_milliwon,
            generated_at
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6::DATE, $7::DATE,
            $8, $9,
            $10, $11,
            $12, $13, $14,
            $15, $16,
            $17,
            now()
        )
        ON CONFLICT (org_id, exit_case_id)
        DO UPDATE SET
            status = EXCLUDED.status,
            service_days = EXCLUDED.service_days,
            average_wage_period_start = EXCLUDED.average_wage_period_start,
            average_wage_period_end = EXCLUDED.average_wage_period_end,
            average_wage_calendar_days = EXCLUDED.average_wage_calendar_days,
            average_wage_total_won = EXCLUDED.average_wage_total_won,
            average_daily_wage_milliwon = EXCLUDED.average_daily_wage_milliwon,
            severance_pay_won = EXCLUDED.severance_pay_won,
            missing_source_fields = EXCLUDED.missing_source_fields,
            statutory_basis = EXCLUDED.statutory_basis,
            insurance_loss_payload = EXCLUDED.insurance_loss_payload,
            monthly_ordinary_wage_won = EXCLUDED.monthly_ordinary_wage_won,
            ordinary_daily_wage_won = EXCLUDED.ordinary_daily_wage_won,
            statutory_daily_wage_milliwon = EXCLUDED.statutory_daily_wage_milliwon,
            -- Atomic re-uncertification (0093 HIGH #1): recomputing settlement fields
            -- invalidates any prior 노무사/세무사 certification. Reset here explicitly
            -- AND enforced for every write path by migration 0094's
            -- enforce_settlement_certification_reset() BEFORE UPDATE trigger. This
            -- path is never itself a certification action.
            certification_status = 'UNCERTIFIED_DRAFT',
            certification_artifact = NULL,
            certified_package_digest = NULL,
            generated_at = now(),
            updated_at = now()
        RETURNING id
        "#,
    )
    .bind(org_uuid)
    .bind(case_id)
    .bind(context.employee_id)
    .bind(package_status)
    .bind(service_days)
    .bind(period_start.as_deref())
    .bind(period_end.as_deref())
    .bind(calendar_days)
    .bind(total_won)
    .bind(daily_milliwon)
    .bind(severance_pay_won)
    .bind(missing_source_fields)
    .bind(statutory_basis)
    .bind(insurance_loss_payload)
    .bind(monthly_ordinary_wage_won)
    .bind(ordinary_daily_wage_won)
    .bind(statutory_daily_wage_milliwon)
    .fetch_one(tx.as_mut())
    .await?;

    if package_status == "READY_FOR_APPROVAL" {
        sqlx::query(
            r#"
            UPDATE employee_exit_cases
            SET status = CASE
                    WHEN status = 'HQ_CONFIRMED' THEN 'SETTLEMENT_READY'
                    ELSE status
                END,
                updated_at = now()
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_uuid)
        .bind(case_id)
        .execute(tx.as_mut())
        .await?;
    }

    Ok(package_id)
}
