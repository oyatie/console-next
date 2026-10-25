// SPDX-License-Identifier: LicenseRef-Proprietary
//! The transaction's statutory row, including its review state; absent coverage never invents a value.
use crate::HrError;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use time::Date;

#[derive(Debug, Clone, Serialize)]
pub struct LegalRule {
    pub code: String,
    pub value: Option<i64>,
    pub unit: String,
    pub instrument: Option<String>,
    pub article: Option<String>,
    pub source_url: Option<String>,
    pub retrieved_on: Option<String>,
    pub provenance: Option<String>,
    pub release_disposition: String,
    pub exception_grounds: Vec<Value>,
}
impl LegalRule {
    pub(crate) fn whole(&self, unit: &str) -> Option<i64> {
        (self.unit == unit).then_some(self.value).flatten()
    }
}
pub(crate) async fn rule(
    conn: &mut PgConnection,
    code: &str,
    on: Date,
) -> Result<LegalRule, HrError> {
    let rows = sqlx::query("SELECT *, effective_from <= $2 AND (effective_to_exclusive IS NULL OR $2 < effective_to_exclusive) AS active FROM statutory_rules WHERE code=$1 ORDER BY active DESC,effective_from DESC")
        .bind(code).bind(on).fetch_all(conn).await?;
    let active = rows.iter().filter(|r| r.get::<bool, _>("active")).count();
    let row = rows.first();
    Ok(LegalRule {
        code: code.into(),
        value: row
            .filter(|r| active == 1 && r.get::<i64, _>("value_den") == 1)
            .map(|r| r.get("value_num")),
        unit: row.map(|r| r.get("unit")).unwrap_or_default(),
        instrument: row.map(|r| r.get("instrument_ko")),
        article: row.map(|r| r.get("article_ko")),
        source_url: row.map(|r| r.get("source_url")),
        retrieved_on: row.map(|r| r.get::<Date, _>("retrieved_on").to_string()),
        provenance: row.map(|r| r.get("provenance_ko")),
        release_disposition: if active == 1 {
            row.map(|r| r.get("release_disposition"))
                .unwrap_or_default()
        } else {
            "UNKNOWN".into()
        },
        exception_grounds: row
            .and_then(|r| r.get::<Option<Value>, _>("notice_exception_grounds"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default(),
    })
}

#[derive(Debug, Serialize)]
pub struct LeaveProtectionRule {
    pub leave_type: String,
    pub rule: LegalRule,
}
pub(crate) async fn leave_rules(
    conn: &mut PgConnection,
    on: Date,
) -> Result<Vec<LeaveProtectionRule>, HrError> {
    let rows: Vec<(String,Vec<String>)> = sqlx::query_as("SELECT DISTINCT code,protection_leave_types FROM statutory_rules WHERE cardinality(protection_leave_types)>0 ORDER BY code")
        .fetch_all(&mut *conn).await?;
    let mut result = Vec::new();
    for (code, types) in rows {
        let row = rule(conn, &code, on).await?;
        for leave_type in types {
            if !result
                .iter()
                .any(|r: &LeaveProtectionRule| r.leave_type == leave_type)
            {
                result.push(LeaveProtectionRule {
                    leave_type,
                    rule: row.clone(),
                });
            }
        }
    }
    Ok(result)
}
