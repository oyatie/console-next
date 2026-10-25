// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read the name and operating state from their owners in one tenant-scoped query.
use std::{future::Future, pin::Pin};

use console_identity_application::{TenantFactsRead, UserTenant};
use console_kernel_core::{KernelError, OrgId, TenantPhase};
use console_platform_db::with_org_conn;
use time::OffsetDateTime;

use crate::{PgOnboardingError, PgOnboardingStore};

impl TenantFactsRead for PgOnboardingStore {
    fn read_tenant(
        &self,
        org: OrgId,
    ) -> Pin<Box<dyn Future<Output = Result<UserTenant, KernelError>> + Send + '_>> {
        Box::pin(async move {
            with_org_conn(&self.pool, org, |tx| {
                Box::pin(async move {
                    let (name, phase, go_live_at): (String, Option<String>, Option<OffsetDateTime>) = sqlx::query_as(
                        "SELECT o.name, p.phase, p.go_live_at FROM organizations o LEFT JOIN tenant_phase p ON p.org_id = o.id WHERE o.id = $1",
                    )
                    .bind(org.as_uuid())
                    .fetch_one(tx.as_mut())
                    .await?;
                    Ok::<_, PgOnboardingError>(UserTenant {
                        name,
                        phase: TenantPhase::from_db(phase.as_deref()),
                        go_live_at,
                    })
                })
            })
            .await
            .map_err(|error| {
                tracing::error!(%error, "tenant facts read failed");
                match error {
                    PgOnboardingError::Db(db) if db.is_unavailable() => {
                        KernelError::unavailable("tenant facts read unavailable")
                    }
                    _ => KernelError::internal("tenant facts read failed"),
                }
            })
        })
    }
}
