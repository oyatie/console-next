// SPDX-License-Identifier: LicenseRef-Proprietary
//! Batched user summary loaders (`ANY($1)`) replacing per-row list lookups.

use std::collections::HashMap;

use console_identity_application::UserSummary;
use console_kernel_core::BranchId;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::error::PgOrgError;
use crate::users::rows::{
    USER_SELECT_DIRECTORY, USER_SELECT_WITH_PASSKEY, user_from_directory_row, user_from_row,
};

async fn fetch_user_branches_batch_tx(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<BranchId>>, PgOrgError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT user_id, branch_id FROM user_branches \
         WHERE user_id = ANY($1) ORDER BY user_id, branch_id",
    )
    .bind(ids)
    .fetch_all(tx.as_mut())
    .await?;

    let mut out: HashMap<Uuid, Vec<BranchId>> = HashMap::new();
    for (user_id, branch_id) in rows {
        out.entry(user_id)
            .or_default()
            .push(BranchId::from_uuid(branch_id));
    }
    Ok(out)
}

async fn fetch_batch_tx(
    tx: &mut Transaction<'_, Postgres>,
    base_select: &str,
    ids: &[Uuid],
    map_row: fn(&sqlx::postgres::PgRow, Vec<BranchId>) -> Result<UserSummary, PgOrgError>,
) -> Result<Vec<UserSummary>, PgOrgError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let query = base_select.replacen("WHERE u.id = $1", "WHERE u.id = ANY($1)", 1);
    debug_assert_ne!(query, base_select, "expected WHERE u.id = $1 clause");
    let rows = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(ids)
        .fetch_all(tx.as_mut())
        .await?;
    let mut branches = fetch_user_branches_batch_tx(tx, ids).await?;

    let mut by_id = HashMap::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id")?;
        let user_branches = branches.remove(&id).unwrap_or_default();
        by_id.insert(id, map_row(row, user_branches)?);
    }

    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

pub(crate) async fn fetch_users_by_ids_tx(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<Vec<UserSummary>, PgOrgError> {
    fetch_batch_tx(tx, USER_SELECT_WITH_PASSKEY, ids, user_from_row).await
}

pub(crate) async fn fetch_directory_users_by_ids_tx(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<Vec<UserSummary>, PgOrgError> {
    fetch_batch_tx(tx, USER_SELECT_DIRECTORY, ids, user_from_directory_row).await
}
