//! The settlement package upsert (moved from `app/src/hr.rs`, R2-exits).

use sqlx::Postgres;
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
    ) = build_settlement_calculation(&context, settlement_input.as_ref())?;
    let statutory_basis = exit_statutory_basis();
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
