// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_db::support::{Session, SupportError};
use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow, Serialize)]
pub(super) struct Active {
    id: Uuid,
    operator_label: String,
    #[serde(with = "console_kernel_core::timestamp")]
    expires_at: OffsetDateTime,
}

#[derive(sqlx::FromRow, Serialize)]
pub(super) struct Pending {
    id: Uuid,
    operator_label: String,
    ticket_ref: String,
    reason: String,
    #[serde(with = "console_kernel_core::timestamp")]
    request_expires_at: OffsetDateTime,
}

#[derive(sqlx::FromRow, Serialize)]
pub(super) struct History {
    #[sqlx(flatten)]
    #[serde(flatten)]
    session: Session,
    ticket_ref: String,
    reason: String,
    mode: String,
    tenant_approver_ref: Option<Uuid>,
    #[serde(with = "console_kernel_core::timestamp::option")]
    operator_approved_at: Option<OffsetDateTime>,
    #[serde(with = "console_kernel_core::timestamp::option")]
    started_at: Option<OffsetDateTime>,
    #[serde(with = "console_kernel_core::timestamp::option")]
    ended_at: Option<OffsetDateTime>,
    decisions: Json<Vec<Decision>>,
    records: Json<Vec<Record>>,
}

#[derive(Deserialize, Serialize)]
struct Decision {
    actor_label: String,
    decision: String,
    #[serde(with = "console_kernel_core::timestamp")]
    at: OffsetDateTime,
}

#[derive(Deserialize, Serialize)]
struct Record {
    id: Uuid,
    method: Option<String>,
    path: Option<String>,
    #[serde(with = "console_kernel_core::timestamp")]
    at: OffsetDateTime,
}

pub(super) async fn history(
    tx: &mut Transaction<'_, Postgres>,
    org: &Uuid,
) -> Result<Vec<History>, SupportError> {
    sqlx::query_as(
        "SELECT s.*, \
         COALESCE((SELECT jsonb_agg(jsonb_build_object( \
           'actor_label',d.actor_label,'decision',d.decision,'at',d.at) ORDER BY d.at,d.id) \
           FROM support_session_decisions d WHERE d.org_id=s.org_id AND d.session_id=s.id), \
           '[]'::jsonb) AS decisions, \
         COALESCE((SELECT jsonb_agg(jsonb_build_object( \
           'id',a.id,'method',a.after_snap->>'method','path',a.after_snap->>'path', \
           'at',a.occurred_at) ORDER BY a.occurred_at,a.id) \
           FROM audit_events a WHERE a.org_id=s.org_id AND a.target_id=s.id::text \
           AND a.action='support.access'),'[]'::jsonb) AS records \
         FROM support_sessions s WHERE s.org_id=$1 ORDER BY s.requested_at DESC,s.id",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await
    .map_err(SupportError::from)
}
