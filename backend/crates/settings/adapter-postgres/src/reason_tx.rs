//! The [`ReasonCodeStore`] port on one armed transaction.

use crate::read::db_error;
use console_kernel_core::{KernelError, OrgId, Timestamp};
use console_settings_application::Actor;
use console_settings_application::reason_codes::{ReasonCodeStore, TenantCodeView};
use console_settings_domain::code_lists::{NewTenantCode, ReasonDomain};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};

pub(crate) fn view(row: &PgRow) -> Result<TenantCodeView, KernelError> {
    let domain: String = row.try_get("domain").map_err(db_error)?;
    Ok(TenantCodeView {
        domain: domain
            .parse()
            .map_err(|_| KernelError::internal("stored reason domain is not registered"))?,
        code: row.try_get("code").map_err(db_error)?,
        label_ko: row.try_get("label_ko").map_err(db_error)?,
        label_en: row.try_get("label_en").map_err(db_error)?,
        requires_note: row.try_get("requires_note").map_err(db_error)?,
        involuntary: row.try_get("involuntary").map_err(db_error)?,
        notice_required: row.try_get("notice_required").map_err(db_error)?,
        active: row.try_get("active").map_err(db_error)?,
        sort: row.try_get("sort").map_err(db_error)?,
    })
}

pub(crate) struct PgReasonTx<'a, 'c> {
    pub(crate) tx: &'a mut Transaction<'c, Postgres>,
    pub(crate) org: OrgId,
}

impl ReasonCodeStore for PgReasonTx<'_, '_> {
    async fn now(&mut self) -> Result<Timestamp, KernelError> {
        sqlx::query_scalar("SELECT now()")
            .fetch_one(self.tx.as_mut())
            .await
            .map_err(db_error)
    }

    async fn insert(
        &mut self,
        code: &NewTenantCode,
        sort: i32,
        by: Actor,
    ) -> Result<TenantCodeView, KernelError> {
        let row = sqlx::query(
            "INSERT INTO reason_codes
                 (org_id, domain, code, label_ko, label_en, requires_note, sort, created_by,
                  involuntary, notice_required)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING domain, code, label_ko, label_en, requires_note, active, sort,
                       involuntary, notice_required",
        )
        .bind(self.org.as_uuid())
        .bind(code.domain.as_str())
        .bind(&code.code)
        .bind(&code.label_ko)
        .bind(&code.label_en)
        .bind(code.requires_note)
        .bind(sort)
        .bind(by.user.as_uuid())
        .bind(code.involuntary)
        .bind(code.notice_required)
        .fetch_one(self.tx.as_mut())
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                KernelError::conflict("a code with this label already exists in the domain")
                    .with_code("reason_label_taken")
                    .with_field("label_ko")
            }
            _ => db_error(e),
        })?;
        view(&row)
    }

    async fn update(
        &mut self,
        domain: ReasonDomain,
        code: &str,
        active: Option<bool>,
        sort: Option<i32>,
    ) -> Result<Option<(TenantCodeView, TenantCodeView)>, KernelError> {
        let before = sqlx::query(
            "SELECT domain, code, label_ko, label_en, requires_note, active, sort,
                    involuntary, notice_required
               FROM reason_codes
              WHERE org_id = $1 AND domain = $2 AND code = $3
                FOR UPDATE",
        )
        .bind(self.org.as_uuid())
        .bind(domain.as_str())
        .bind(code)
        .fetch_optional(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        let Some(before) = before else {
            return Ok(None);
        };
        let after = sqlx::query(
            "UPDATE reason_codes
                SET active = coalesce($4, active), sort = coalesce($5, sort)
              WHERE org_id = $1 AND domain = $2 AND code = $3
             RETURNING domain, code, label_ko, label_en, requires_note, active, sort,
                       involuntary, notice_required",
        )
        .bind(self.org.as_uuid())
        .bind(domain.as_str())
        .bind(code)
        .bind(active)
        .bind(sort)
        .fetch_one(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        Ok(Some((view(&before)?, view(&after)?)))
    }
}
