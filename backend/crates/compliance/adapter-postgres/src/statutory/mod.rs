//! Reads the BW-30 statutory register (`statutory_rules`, `insurance_loss_codes`).
//!
//! Both tables are global, migration-only and SELECT-only to `console_rt`, so
//! there is no org scope and nothing to audit. The whole register is loaded and
//! validated at once: an unknown code or an overlapping period fails the load
//! (fail closed) instead of answering from a half-valid register.

use console_compliance_domain::statutory::{
    Citation, InsuranceLossCode, Insurer, LossReasonGroup, ReleaseDisposition, StatutoryRegister,
    StatutoryRule, StatutoryUnit,
};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};

use crate::{PgComplianceError, PgComplianceStore};

impl PgComplianceStore {
    /// The validated statutory register, read on a pooled connection.
    pub async fn statutory_register(&self) -> Result<StatutoryRegister, PgComplianceError> {
        let mut conn = self.pool().acquire().await?;
        load_statutory_register(&mut conn).await
    }
}

/// Loads and validates the register on `conn`. Callers that need the register
/// inside their own transaction pass `&mut *tx`.
pub async fn load_statutory_register(
    conn: &mut PgConnection,
) -> Result<StatutoryRegister, PgComplianceError> {
    let rules = sqlx::query(
        "SELECT code, effective_from, effective_to_exclusive, unit, value_num, value_den, \
                instrument_ko, article_ko, source_url, release_disposition, review_receipt_ref \
         FROM statutory_rules ORDER BY code, effective_from",
    )
    .fetch_all(&mut *conn)
    .await?
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
    .await?
    .iter()
    .map(loss_code_from_row)
    .collect::<Result<Vec<_>, _>>()?;
    let filing_rows: Vec<serde_json::Value> = sqlx::query_scalar("SELECT filing_rule FROM statutory_rules WHERE filing_rule IS NOT NULL ORDER BY code,effective_from")
        .fetch_all(&mut *conn).await?;
    let filing_rules = filing_rows
        .into_iter()
        .map(|v| {
            serde_json::from_value(v)
                .map_err(|e| console_kernel_core::KernelError::validation(e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(StatutoryRegister::new(rules, loss_codes)?.with_filing_rules(filing_rules)?)
}

fn citation(row: &PgRow) -> Result<Citation, sqlx::Error> {
    Ok(Citation {
        instrument_ko: row.try_get("instrument_ko")?,
        article_ko: row.try_get("article_ko")?,
        source_url: row.try_get("source_url")?,
    })
}

fn disposition(row: &PgRow) -> Result<ReleaseDisposition, PgComplianceError> {
    let disposition: String = row.try_get("release_disposition")?;
    Ok(ReleaseDisposition::from_db(
        &disposition,
        row.try_get("review_receipt_ref")?,
    )?)
}

fn rule_from_row(row: &PgRow) -> Result<StatutoryRule, PgComplianceError> {
    let unit: String = row.try_get("unit")?;
    Ok(StatutoryRule {
        code: row.try_get("code")?,
        effective_from: row.try_get("effective_from")?,
        effective_to_exclusive: row.try_get("effective_to_exclusive")?,
        unit: StatutoryUnit::from_db_str(&unit)?,
        value_num: row.try_get("value_num")?,
        value_den: row.try_get("value_den")?,
        citation: citation(row)?,
        disposition: disposition(row)?,
    })
}

fn loss_code_from_row(row: &PgRow) -> Result<InsuranceLossCode, PgComplianceError> {
    let insurer: String = row.try_get("insurer")?;
    let group: String = row.try_get("reason_group")?;
    Ok(InsuranceLossCode {
        insurer: Insurer::from_db_str(&insurer)?,
        code: row.try_get("code")?,
        label_ko: row.try_get("label_ko")?,
        group: LossReasonGroup::from_db_str(&group)?,
        requires_detail: row.try_get("requires_detail")?,
        effective_from: row.try_get("effective_from")?,
        effective_to_exclusive: row.try_get("effective_to_exclusive")?,
        citation: citation(row)?,
        disposition: disposition(row)?,
    })
}
