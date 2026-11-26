// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn load_summary(
    tx: &mut Transaction<'_, Postgres>,
    voucher_id: VoucherId,
) -> Result<VoucherSummary, PgVoucherError> {
    load_summaries(tx, &[*voucher_id.as_uuid()])
        .await?
        .pop()
        .ok_or_else(|| KernelError::not_found("voucher was not found").into())
}

pub(super) async fn load_summaries(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<Vec<VoucherSummary>, PgVoucherError> {
    let headers = sqlx::query(
        r#"
        SELECT id, voucher_no, branch_id, status, memo,
               source_object_type, source_object_id,
               reversal_of_voucher_id, reversed_by_voucher_id,
               created_by, approved_by, posted_at, created_at, updated_at,
               -- Same-org correlated lookups (RLS-scoped to app.current_org,
               -- exactly like the LEFT JOIN they stand in for) — resolve the
               -- branch/user display names so the inspector never has to show
               -- a raw id. NULL only for a deleted row (branches never are,
               -- via FK RESTRICT; a deleted user leaves NULL, same as
               -- support's assignee_name).
               (SELECT b.name FROM branches b
                 WHERE b.id = finance_gl_vouchers.branch_id) AS branch_name,
               (SELECT u.display_name FROM person_accounts_current u
                 WHERE u.id = finance_gl_vouchers.created_by) AS created_by_name,
               (SELECT u.display_name FROM person_accounts_current u
                 WHERE u.id = finance_gl_vouchers.approved_by) AS approved_by_name
        FROM finance_gl_vouchers
        WHERE id = ANY($1)
        ORDER BY array_position($1, id)
        "#,
    )
    .bind(ids)
    .fetch_all(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    let line_rows = sqlx::query(
        r#"
        SELECT voucher_id, id, line_no, account_code, side, amount_won, memo
        FROM finance_gl_voucher_lines
        WHERE voucher_id = ANY($1)
        ORDER BY line_no ASC
        "#,
    )
    .bind(ids)
    .fetch_all(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;

    let mut grouped = std::collections::HashMap::<Uuid, Vec<_>>::new();
    for line in line_rows {
        grouped
            .entry(line.get("voucher_id"))
            .or_default()
            .push(line);
    }
    headers
        .into_iter()
        .map(|row| {
            let id = row.get::<Uuid, _>("id");
            let line_rows = grouped.remove(&id).unwrap_or_default();
            let mut lines = Vec::with_capacity(line_rows.len());
            let mut debit_total_won: i64 = 0;
            let mut credit_total_won: i64 = 0;
            for lr in line_rows {
                let side = DebitCredit::from_db_str(&lr.get::<String, _>("side"))?;
                let amount_won = lr.get::<i64, _>("amount_won");
                match side {
                    DebitCredit::Debit => {
                        debit_total_won = debit_total_won.saturating_add(amount_won);
                    }
                    DebitCredit::Credit => {
                        credit_total_won = credit_total_won.saturating_add(amount_won);
                    }
                }
                lines.push(VoucherLineSummary {
                    id: lr.get::<Uuid, _>("id"),
                    line_no: lr.get::<i32, _>("line_no"),
                    account_code: lr.get::<String, _>("account_code"),
                    side,
                    amount_won,
                    memo: lr.get::<String, _>("memo"),
                });
            }

            Ok(VoucherSummary {
                id: VoucherId::from_uuid(row.get::<Uuid, _>("id")),
                voucher_no: row.get::<String, _>("voucher_no"),
                branch_id: BranchId::from_uuid(row.get::<Uuid, _>("branch_id")),
                branch_name: row.get::<Option<String>, _>("branch_name"),
                status: VoucherStatus::from_db_str(&row.get::<String, _>("status"))?,
                memo: row.get::<String, _>("memo"),
                source_object_type: row.get::<Option<String>, _>("source_object_type"),
                source_object_id: row.get::<Option<String>, _>("source_object_id"),
                reversal_of_voucher_id: row
                    .get::<Option<Uuid>, _>("reversal_of_voucher_id")
                    .map(VoucherId::from_uuid),
                reversed_by_voucher_id: row
                    .get::<Option<Uuid>, _>("reversed_by_voucher_id")
                    .map(VoucherId::from_uuid),
                debit_total_won,
                credit_total_won,
                lines,
                created_by: UserId::from_uuid(row.get::<Uuid, _>("created_by")),
                created_by_name: row.get::<Option<String>, _>("created_by_name"),
                approved_by: row
                    .get::<Option<Uuid>, _>("approved_by")
                    .map(UserId::from_uuid),
                approved_by_name: row.get::<Option<String>, _>("approved_by_name"),
                posted_at: row.get::<Option<OffsetDateTime>, _>("posted_at"),
                created_at: row.get::<OffsetDateTime, _>("created_at"),
                updated_at: row.get::<OffsetDateTime, _>("updated_at"),
            })
        })
        .collect()
}
