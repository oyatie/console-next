// SPDX-License-Identifier: LicenseRef-Proprietary
use std::future::Future;
use std::pin::Pin;

use super::SOURCE_TIMEOUT;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceFailure {
    /// Ordinary source-read denial: the aggregate remains a partial 200 when
    /// another source succeeds. It is intentionally distinct from preflight
    /// explicit-branch scope denial.
    Denied {
        code: &'static str,
    },
    Unavailable {
        code: &'static str,
    },
}

pub type SourceFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, SourceFailure>> + Send + 'a>>;

pub(super) async fn bounded_source<T>(future: SourceFuture<'_, T>) -> Result<T, SourceFailure> {
    match tokio::time::timeout(SOURCE_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(SourceFailure::Unavailable {
            code: "source_timeout",
        }),
    }
}
