//! INF-03 idle sign-out at the request boundary (design/security-admin.md
//! R-3). The header-reading entry points ([`crate::resolve_principal`] and the
//! platform extractor) scope the request's `X-Last-Interaction` here; the
//! claims check reads the family's activity in its existing query and calls
//! [`check`]. Callers that validate claims without headers (realtime
//! handshakes, auth-rest's own extractors) are still checked; they just never
//! advance activity. An idle family is refused here and ended by the refresh
//! that follows (`session_idle_expired`).

use std::future::Future;

use console_kernel_core::{OrgId, Timestamp};
use console_platform_auth::idle::{
    LAST_INTERACTION_HEADER, effective_activity, idle_at_request, needs_write_back,
    parse_last_interaction, resolve_idle_minutes,
};
use console_platform_db::{DbError, with_org_conn};
use http::HeaderMap;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::RequestContextError;

tokio::task_local! {
    static LAST_INTERACTION: Option<String>;
}

/// Run `f` with the request's `X-Last-Interaction` in scope.
pub(crate) async fn with_last_interaction<F: Future>(headers: &HeaderMap, f: F) -> F::Output {
    let sent = headers
        .get(LAST_INTERACTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    LAST_INTERACTION.scope(sent, f).await
}

/// Activity to record after the request's claims transaction commits.
pub(crate) struct WriteBack {
    home: OrgId,
    family: Uuid,
    at: Timestamp,
    minutes: i32,
}

/// Refuse (401) a family idle past its timeout. `snapshot` is the family's
/// `idle_timeout_minutes`; until the first one, the tenant's value is resolved
/// on `tx` (armed to `home`). Returns the write-back the request owes, if any.
pub(crate) async fn check(
    tx: &mut Transaction<'_, Postgres>,
    home: OrgId,
    family: Uuid,
    (stored, snapshot, now): (Timestamp, Option<i32>, Timestamp),
) -> Result<Option<WriteBack>, RequestContextError> {
    let unavailable =
        |_| RequestContextError::EffectivePolicy("session activity unavailable".into());
    let minutes = match snapshot {
        Some(minutes) => minutes,
        None => i32::try_from(
            resolve_idle_minutes(tx.as_mut(), home, now)
                .await
                .map_err(unavailable)?,
        )
        .map_err(|_| RequestContextError::EffectivePolicy("idle timeout out of range".into()))?,
    };
    let sent = LAST_INTERACTION
        .try_with(|sent| parse_last_interaction(sent.as_deref()))
        .ok()
        .flatten();
    if idle_at_request(stored, sent, now, i64::from(minutes)) {
        return Err(RequestContextError::InvalidToken);
    }
    let at = effective_activity(stored, sent, now);
    Ok(
        (snapshot.is_none() || needs_write_back(stored, at)).then_some(WriteBack {
            home,
            family,
            at,
            minutes,
        }),
    )
}

/// Record activity (and the snapshot) in its own short transaction, after the
/// claims transaction released its share lock on the family: at most once a
/// minute per session. Best effort: a failure only delays the next write.
pub(crate) async fn write_back(pool: &PgPool, write: Option<WriteBack>) {
    let Some(WriteBack {
        home,
        family,
        at,
        minutes,
    }) = write
    else {
        return;
    };
    let written = with_org_conn::<_, _, DbError>(pool, home, |tx| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE auth_refresh_token_families \
                    SET last_activity_at = GREATEST(last_activity_at, $2), \
                        idle_timeout_minutes = COALESCE(idle_timeout_minutes, $3) \
                  WHERE id = $1 AND revoked_at IS NULL",
            )
            .bind(family)
            .bind(at)
            .bind(minutes)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok(())
        })
    })
    .await;
    if let Err(error) = written {
        tracing::warn!(%error, "session activity write-back failed");
    }
}
