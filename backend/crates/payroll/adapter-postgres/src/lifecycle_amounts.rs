// SPDX-License-Identifier: LicenseRef-Proprietary
use console_payroll_domain::VerifiedNtsTaxRow;
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(PartialEq, Eq)]
pub(super) struct SourceAmounts {
    pub(super) gross_won: i64,
    pub(super) base_pay_won: Option<i64>,
    pub(super) overtime_pay_won: Option<i64>,
    pub(super) meal_allowance_won: Option<i64>,
    pub(super) taxable_won: Option<i64>,
    pub(super) pension_standard_monthly_income_won: Option<i64>,
    pub(super) tax_row: VerifiedNtsTaxRow,
}

pub(super) fn select_source_amounts(
    canonical_rows: &[Value],
) -> Result<SourceAmounts, &'static str> {
    let mut results = canonical_rows.iter().filter_map(extract_source_amounts);
    let Some(first) = results.next() else {
        return Err("SOURCE_AMOUNTS_NOT_MATERIALIZED");
    };
    let first = first?;
    for next in results {
        let next = next?;
        if next != first {
            return Err("SOURCE_AMOUNTS_CONFLICTING");
        }
    }
    Ok(first)
}

fn optional_non_negative_won(payroll: &Value, key: &str) -> Result<Option<i64>, &'static str> {
    match payroll.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_i64() {
            Some(amount) if amount >= 0 => Ok(Some(amount)),
            _ => Err("SOURCE_AMOUNTS_INVALID"),
        },
    }
}

fn extract_source_amounts(canonical_row: &Value) -> Option<Result<SourceAmounts, &'static str>> {
    let payroll = canonical_row.get("payroll")?;
    let tax = payroll.get("nts_tax_row")?;
    let gross_won = payroll.get("monthly_gross_pay_won")?.as_i64()?;
    let table_version = tax.get("table_version")?.as_str()?.to_owned();
    let monthly_income_tax_won = tax.get("monthly_income_tax_won")?.as_i64()?;
    let local_income_tax_won = tax.get("local_income_tax_won")?.as_i64()?;
    let base_pay_won = match optional_non_negative_won(payroll, "base_pay_won") {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    let overtime_pay_won = match optional_non_negative_won(payroll, "overtime_pay_won") {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    let meal_allowance_won = match optional_non_negative_won(payroll, "meal_allowance_won") {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    let explicit_taxable_won = match optional_non_negative_won(payroll, "taxable_won") {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    let taxable_won = explicit_taxable_won.or_else(|| {
        meal_allowance_won
            .filter(|meal| *meal <= gross_won)
            .and_then(|meal| gross_won.checked_sub(meal))
    });
    Some(Ok(SourceAmounts {
        gross_won,
        base_pay_won,
        overtime_pay_won,
        meal_allowance_won,
        taxable_won,
        pension_standard_monthly_income_won: payroll
            .get("pension_standard_monthly_income_won")
            .and_then(Value::as_i64),
        tax_row: VerifiedNtsTaxRow {
            table_version,
            monthly_income_tax_won,
            local_income_tax_won,
        },
    }))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_line_calculation_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    line_id: Uuid,
    version: i32,
    gross_won: i64,
    deductions: &[Value],
    total_deductions_won: i64,
    net_won: i64,
    tax_table_version: &str,
    breakdown: [Option<i64>; 4],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO payroll_line_calculations \
         (org_id, run_id, line_id, version, gross_won, deductions, \
          total_deductions_won, net_won, tax_table_version, \
          base_pay_won, overtime_pay_won, meal_allowance_won, taxable_won) \
         SELECT l.org_id, l.run_id, l.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 \
         FROM payroll_draft_lines l WHERE l.id = $1",
    )
    .bind(line_id)
    .bind(version)
    .bind(gross_won)
    .bind(Value::Array(deductions.to_vec()))
    .bind(total_deductions_won)
    .bind(net_won)
    .bind(tax_table_version)
    .bind(breakdown[0])
    .bind(breakdown[1])
    .bind(breakdown[2])
    .bind(breakdown[3])
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
