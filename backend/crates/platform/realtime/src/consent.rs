// SPDX-License-Identifier: LicenseRef-Proprietary
//! Required document changes use the existing account stream, including scheduled publication.
use sqlx::postgres::PgListener;
use tokio::time::Instant;

use crate::{PgRealtimeHub, RealtimeEvent};

pub(crate) const CHANNEL: &str = "privacy_consent_changed";

pub(crate) async fn next_publication(
    listener: &mut PgListener,
) -> Result<Option<Instant>, sqlx::Error> {
    let (next, now): (Option<time::OffsetDateTime>, time::OffsetDateTime) =
        sqlx::query_as("SELECT next_consent_publication(), clock_timestamp()")
            .fetch_one(listener)
            .await?;
    Ok(next.map(|at| Instant::now() + std::time::Duration::try_from(at - now).unwrap_or_default()))
}

pub(crate) async fn wait_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl PgRealtimeHub {
    pub(crate) async fn consent_changed(&self) {
        let targets: Vec<_> = self
            .connections
            .lock()
            .await
            .iter()
            .filter(|(_, slot)| slot.reader.is_some())
            .map(|(id, _)| *id)
            .collect();
        for id in targets {
            self.dispatch_to_connection(
                id,
                RealtimeEvent::PrivacyConsent { accepted: false },
                None,
            )
            .await;
        }
    }
}
