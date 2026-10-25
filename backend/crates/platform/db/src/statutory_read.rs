// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared read of the migration-owned statutory register on the caller's connection.
use console_compliance_domain::statutory::{
    Citation, InsuranceLossCode, Insurer, LossReasonGroup, ReleaseDisposition, StatutoryRegister,
    StatutoryRule, StatutoryUnit,
};
use console_kernel_core::KernelError;
use sqlx::{PgConnection, Row, postgres::PgRow};

pub async fn load_statutory_register(
    conn: &mut PgConnection,
) -> Result<StatutoryRegister, KernelError> {
    let rules = sqlx::query(
        "SELECT code, effective_from, effective_to_exclusive, unit, value_num, value_den, \
                instrument_ko, article_ko, source_url, release_disposition, review_receipt_ref \
         FROM lifecycle_statutory_rules ORDER BY code, effective_from",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?
    .iter()
    .map(rule_from_row)
    .collect::<Result<Vec<_>, _>>()?;
    let loss_codes = sqlx::query(
        "SELECT insurer, code, label_ko, reason_group, requires_detail, effective_from, \
                effective_to_exclusive, instrument_ko, article_ko, source_url, \
                release_disposition, review_receipt_ref \
         FROM insurance_loss_codes ORDER BY insurer, code, effective_from",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?
    .iter()
    .map(loss_code_from_row)
    .collect::<Result<Vec<_>, _>>()?;
    let filing_rows = sqlx::query("SELECT filing_rule,trigger_event_kinds FROM lifecycle_statutory_rules WHERE filing_rule IS NOT NULL ORDER BY code,effective_from")
        .fetch_all(&mut *conn).await.map_err(db_error)?;
    let filing_rules = filing_rows
        .into_iter()
        .map(|row| {
            let value: serde_json::Value = row.try_get("filing_rule").map_err(db_error)?;
            let mut rule: console_compliance_domain::statutory::filing::FilingRule =
                serde_json::from_value(value)
                    .map_err(|e| KernelError::validation(e.to_string()))?;
            rule.trigger_event_kinds = row.try_get("trigger_event_kinds").map_err(db_error)?;
            Ok::<_, KernelError>(rule)
        })
        .collect::<Result<Vec<_>, _>>()?;
    StatutoryRegister::new(rules, loss_codes)?.with_filing_rules(filing_rules)
}

fn citation(row: &PgRow) -> Result<Citation, KernelError> {
    Ok(Citation {
        instrument_ko: row.try_get("instrument_ko").map_err(db_error)?,
        article_ko: row.try_get("article_ko").map_err(db_error)?,
        source_url: row.try_get("source_url").map_err(db_error)?,
    })
}

fn disposition(row: &PgRow) -> Result<ReleaseDisposition, KernelError> {
    let disposition: String = row.try_get("release_disposition").map_err(db_error)?;
    ReleaseDisposition::from_db(
        &disposition,
        row.try_get("review_receipt_ref").map_err(db_error)?,
    )
}

fn rule_from_row(row: &PgRow) -> Result<StatutoryRule, KernelError> {
    let unit: String = row.try_get("unit").map_err(db_error)?;
    Ok(StatutoryRule {
        code: row.try_get("code").map_err(db_error)?,
        effective_from: row.try_get("effective_from").map_err(db_error)?,
        effective_to_exclusive: row.try_get("effective_to_exclusive").map_err(db_error)?,
        unit: StatutoryUnit::from_db_str(&unit)?,
        value_num: row.try_get("value_num").map_err(db_error)?,
        value_den: row.try_get("value_den").map_err(db_error)?,
        citation: citation(row)?,
        disposition: disposition(row)?,
    })
}

fn loss_code_from_row(row: &PgRow) -> Result<InsuranceLossCode, KernelError> {
    let insurer: String = row.try_get("insurer").map_err(db_error)?;
    let group: String = row.try_get("reason_group").map_err(db_error)?;
    Ok(InsuranceLossCode {
        insurer: Insurer::from_db_str(&insurer)?,
        code: row.try_get("code").map_err(db_error)?,
        label_ko: row.try_get("label_ko").map_err(db_error)?,
        group: LossReasonGroup::from_db_str(&group)?,
        requires_detail: row.try_get("requires_detail").map_err(db_error)?,
        effective_from: row.try_get("effective_from").map_err(db_error)?,
        effective_to_exclusive: row.try_get("effective_to_exclusive").map_err(db_error)?,
        citation: citation(row)?,
        disposition: disposition(row)?,
    })
}

fn db_error(error: sqlx::Error) -> KernelError {
    let error = crate::DbError::from(error);
    KernelError::new(error.kind(), error.to_string())
}
