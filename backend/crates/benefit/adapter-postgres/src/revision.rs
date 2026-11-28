// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{BenefitCatalogItemId, KernelError, UserId};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

/// The parent row is locked before the current scope and this revision are checked.
pub(super) fn verify(
    current: OffsetDateTime,
    expected: Option<OffsetDateTime>,
) -> Result<(), KernelError> {
    if expected.is_some_and(|value| value != current) {
        return Err(KernelError::conflict(
            "benefit catalog item changed since it was opened",
        ));
    }
    Ok(())
}

pub(super) async fn touch(
    tx: &mut Transaction<'_, Postgres>,
    id: BenefitCatalogItemId,
    actor: UserId,
    at: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE benefit_catalog_items SET updated_by = $2, updated_at = GREATEST(updated_at + INTERVAL '1 microsecond', $3) WHERE id = $1")
        .bind(id.as_uuid()).bind(actor.as_uuid()).bind(at).execute(tx.as_mut()).await?;
    Ok(())
}
