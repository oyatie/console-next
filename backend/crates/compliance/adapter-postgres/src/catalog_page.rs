// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::PgComplianceError;
use console_kernel_core::KernelError;
use console_platform_db::with_org_snapshot;
use console_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, QueryBuilder, postgres::PgRow};

/// Pagination counts and rows, including an empty final page, share one tenant-scoped snapshot.
pub(super) async fn rows(
    pool: &PgPool,
    mut count: QueryBuilder<Postgres>,
    mut page: QueryBuilder<Postgres>,
) -> Result<(i64, Vec<PgRow>), PgComplianceError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_snapshot(pool, org, move |tx| {
        Box::pin(async move {
            let total = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
            let rows = page.build().fetch_all(tx.as_mut()).await?;
            Ok((total, rows))
        })
    })
    .await
}
