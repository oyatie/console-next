// SPDX-License-Identifier: LicenseRef-Proprietary
//! Reservations include pending upgrades and live WebSockets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use axum::http::StatusCode;
use console_kernel_core::{OrgId, UserId};

use crate::auth::RealtimeApiError;
use crate::{ChangeReader, PgRealtimeHub};

#[derive(Debug, Default)]
pub(crate) struct Limits {
    counts: Mutex<Counts>,
}

#[derive(Debug, Default)]
struct Counts {
    accounts: HashMap<(OrgId, UserId), usize>,
    total: usize,
    hits: [u64; 3],
}

pub(crate) struct WsLease {
    hub: Arc<PgRealtimeHub>,
    key: (OrgId, UserId),
    pub(crate) connection: Option<uuid::Uuid>,
}

impl PgRealtimeHub {
    pub(crate) fn acquire_ws(
        self: &Arc<Self>,
        reader: &ChangeReader,
    ) -> Result<WsLease, RealtimeApiError> {
        let key = (reader.org_id(), reader.user_id());
        let mut counts = self
            .limits
            .counts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let open = counts.accounts.get(&key).copied().unwrap_or(0);
        let refusal = if open >= self.config.max_ws_per_account {
            Some((0, "ws_account_limit"))
        } else if counts.total >= self.config.max_ws_total {
            Some((1, "ws_global_limit"))
        } else {
            None
        };
        if let Some((index, code)) = refusal {
            counts.hits[index] += 1;
            tracing::warn!(support_ref = %uuid::Uuid::new_v4(), code, "realtime capacity reached");
            return Err(RealtimeApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                code,
                "too many open WebSockets",
            ));
        }
        counts.accounts.insert(key, open + 1);
        counts.total += 1;
        Ok(WsLease {
            hub: Arc::clone(self),
            key,
            connection: None,
        })
    }

    /// Process counters, with a fixed label set for the metrics exporter.
    pub fn limit_hits(&self) -> [u64; 3] {
        self.limits
            .counts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .hits
    }

    pub(crate) fn replay_limit_hit(&self) {
        self.limits
            .counts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .hits[2] += 1;
        tracing::warn!(support_ref = %uuid::Uuid::new_v4(), code = "replay_limit", "realtime replay budget reached");
    }
}

impl Drop for WsLease {
    fn drop(&mut self) {
        let mut counts = self
            .hub
            .limits
            .counts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(open) = counts.accounts.get_mut(&self.key) {
            *open -= 1;
            if *open == 0 {
                counts.accounts.remove(&self.key);
            }
        }
        counts.total -= 1;
        drop(counts);
        if let (Some(id), Ok(runtime)) = (
            self.connection.take(),
            tokio::runtime::Handle::try_current(),
        ) {
            let hub = Arc::clone(&self.hub);
            runtime.spawn(async move { hub.remove_connection(id).await });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RealtimeHubConfig;
    use console_kernel_core::BranchScope;
    use console_platform_authz::Principal;

    fn reader(org: OrgId, user: UserId) -> ChangeReader {
        Principal::new(user, org, Default::default(), BranchScope::All).into()
    }

    #[tokio::test]
    async fn account_limit_counts_reservations_and_releases_on_drop() {
        let hub = Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig {
            max_ws_per_account: 1,
            ..Default::default()
        }));
        let user = UserId::new();
        let account = reader(OrgId::one(), user);
        let lease = hub.acquire_ws(&account).unwrap();
        let error = hub.acquire_ws(&account).err().unwrap();
        assert_eq!(
            (error.status, error.code),
            (StatusCode::TOO_MANY_REQUESTS, "ws_account_limit")
        );
        let other_tenant = hub.acquire_ws(&reader(OrgId::new(), user)).unwrap();
        drop(lease);
        assert!(hub.acquire_ws(&account).is_ok());
        drop(other_tenant);
        assert!(hub.limits.counts.lock().unwrap().accounts.is_empty());
        assert_eq!(hub.limit_hits(), [1, 0, 0]);
    }

    #[tokio::test]
    async fn global_limit_is_atomic_across_accounts_and_router_clones() {
        let hub = Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig {
            max_ws_total: 1,
            ..Default::default()
        }));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let hub = Arc::clone(&hub);
            tasks.spawn(async move { hub.acquire_ws(&reader(OrgId::one(), UserId::new())) });
        }
        let mut leases = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result.unwrap() {
                Ok(lease) => leases.push(lease),
                Err(error) => assert_eq!(
                    (error.status, error.code),
                    (StatusCode::TOO_MANY_REQUESTS, "ws_global_limit")
                ),
            }
        }
        assert_eq!(leases.len(), 1);
        assert_eq!(hub.limit_hits(), [0, 7, 0]);
        drop(leases);
        assert!(hub.acquire_ws(&reader(OrgId::one(), UserId::new())).is_ok());
    }

    #[tokio::test]
    async fn cancelled_session_releases_reservation_and_slot() {
        let hub = Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig::default()));
        let account = reader(OrgId::one(), UserId::new());
        let mut lease = hub.acquire_ws(&account).unwrap();
        let connection = hub
            .connect(
                crate::RealtimePrincipal {
                    org_id: account.org_id(),
                    user_id: account.user_id(),
                    branch_scope: account.branch_scope(),
                },
                None,
            )
            .await
            .unwrap();
        lease.connection = Some(connection.id());
        let task = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while hub.connection_count().await != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(hub.limits.counts.lock().unwrap().accounts.is_empty());
    }
}
