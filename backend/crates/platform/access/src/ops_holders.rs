// SPDX-License-Identifier: LicenseRef-Proprietary
//! Designating a second ops account holder (`<= 2`) and self-only holder release.

use console_identity_adapter_postgres::{PgOrgError, ops_holders as id_ops};
use console_platform_authz::Principal;
use console_platform_db::with_audits;
use serde::Deserialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::AccessService;
use crate::actor::verify_step_up;
use crate::dto::StepUp;
use crate::effective::ops_in_tx;
use crate::error::{AccessError, AccessResult};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesignateHolder {
    pub account_id: Uuid,
    #[serde(default)]
    pub step_up: Option<StepUp>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ReleaseHolder {
    #[serde(default)]
    pub target_account_id: Option<Uuid>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub step_up: Option<StepUp>,
}

pub(crate) fn map_org_err(err: PgOrgError) -> AccessError {
    match err {
        PgOrgError::Domain(ke) => AccessError::from(ke),
        PgOrgError::Db(console_platform_db::DbError::Sqlx(sqlx::Error::Database(ref db)))
            if db.constraint() == Some("ops_holder_limit_reached") =>
        {
            AccessError::conflict(
                "ops_holder_limit_reached",
                "at most 2 ops account holders are allowed per tenant",
            )
        }
        PgOrgError::Db(console_platform_db::DbError::Sqlx(sqlx::Error::Database(ref db)))
            if db.constraint() == Some("tenant_keeps_ops") =>
        {
            AccessError::conflict(
                "last_ops_holder",
                "at least one active ops account holder must remain",
            )
        }
        PgOrgError::Db(console_platform_db::DbError::Sqlx(sqlx::Error::Database(ref db)))
            if db.code().as_deref() == Some("23505") =>
        {
            AccessError::conflict("conflict", "the requested account binding already exists")
        }
        PgOrgError::Db(db) => AccessError::from(db),
    }
}

pub async fn designate(
    s: &AccessService,
    p: Principal,
    body: DesignateHolder,
) -> AccessResult<Value> {
    if !p.is_tenant_ops {
        return Err(AccessError::forbidden(
            "ops_holder_only",
            "only an active ops account holder can designate another holder",
        ));
    }
    verify_step_up(s, &p, body.step_up).await?;
    let actor = *p.user_id.as_uuid();
    let target = body.account_id;
    let now = OffsetDateTime::now_utc();
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let event = id_ops::designate_ops_holder_in_tx(tx, p.org_id, actor, target, now)
                .await
                .map_err(map_org_err)?;
            let out = ops_in_tx(tx, p.org_id).await?;
            Ok((out, vec![event]))
        })
    })
    .await
}

pub async fn release(s: &AccessService, p: Principal, body: ReleaseHolder) -> AccessResult<Value> {
    let actor = *p.user_id.as_uuid();
    if body.target_account_id.is_some_and(|target| target != actor) {
        return Err(AccessError::forbidden(
            "ops_release_self_only",
            "an ops account holder can release only their own holder status",
        ));
    }
    if !p.is_tenant_ops {
        return Err(AccessError::forbidden(
            "ops_holder_only",
            "only an active ops account holder can release holder status",
        ));
    }
    verify_step_up(s, &p, body.step_up).await?;
    let now = OffsetDateTime::now_utc();
    let reason = body.reason.clone();
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let event = id_ops::release_self_ops_holder_in_tx(
                tx,
                p.org_id,
                actor,
                body.target_account_id,
                reason.as_deref(),
                now,
            )
            .await
            .map_err(map_org_err)?;
            let out = ops_in_tx(tx, p.org_id).await?;
            Ok((out, vec![event]))
        })
    })
    .await
}
