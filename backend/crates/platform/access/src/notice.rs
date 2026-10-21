//! The grant notice (decisions D0.2): a grant counts toward a second person
//! only after its holder was told of it. The holder confirms it in the
//! console; the ledger records who, when and how (`IN_APP`). Out-of-band
//! delivery to the security contact (BW-34) is another channel of the same row.

use std::collections::BTreeMap;

use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::actions::grant_notice;
use console_platform_db::with_audit;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::AccessService;
use crate::actor::audit;
use crate::error::{AccessError, AccessResult};

const CHANNEL: &str = "IN_APP";

/// When each of `account`'s grants was noticed since it was last granted.
pub(crate) async fn noticed(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    account: Uuid,
) -> AccessResult<BTreeMap<String, OffsetDateTime>> {
    let rows = sqlx::query(
        "SELECT n.grant_ref, max(n.occurred_at) AS at FROM authz_grant_ledger n
          WHERE n.org_id = $1 AND n.user_id = $2 AND n.grant_kind = 'ACCESS_GRANT'
            AND n.event = 'NOTICE_DELIVERED'
            AND n.occurred_at >= (SELECT max(g.occurred_at) FROM authz_grant_ledger g
                                   WHERE g.org_id = n.org_id AND g.user_id = n.user_id
                                     AND g.grant_kind = 'ACCESS_GRANT' AND g.grant_ref = n.grant_ref
                                     AND g.event = 'GRANTED')
          GROUP BY n.grant_ref",
    )
    .bind(org.as_uuid())
    .bind(account)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|r| Ok((r.try_get("grant_ref")?, r.try_get("at")?)))
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}

/// The holder confirms the notice of `grant` (idempotent: a confirmed notice
/// answers with its first confirmation). 404 `grant_not_found` for another
/// tenant's or an unknown grant, 403 `grant_notice_not_holder` for someone
/// else's, 409 `grant_ended` for a revoked or ended one.
pub async fn confirm(s: &AccessService, p: Principal, grant: Uuid) -> AccessResult<Value> {
    let event = audit(&p, "access.grant.notice", "access_grants", grant)?
        .with_snapshots(None, Some(json!({ "channel": CHANNEL })));
    let me = *p.user_id.as_uuid();
    with_audit::<_, _, AccessError>(&s.pool, event, move |tx| {
        Box::pin(async move {
            let org = p.org_id;
            let row = sqlx::query(
                "SELECT org_id, account_id,
                        status = 'ACTIVE' AND (valid_to IS NULL OR valid_to > now()) AS live
                   FROM access_grants WHERE org_id = $1 AND id = $2 FOR SHARE",
            )
            .bind(org.as_uuid())
            .bind(grant)
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| AccessError::not_found("grant_not_found", "no such grant"))?;
            let grant_org: Uuid = row.try_get("org_id")?;
            let is_holder = row.try_get::<Uuid, _>("account_id")? == me;
            let live: bool = row.try_get("live")?;
            if !grant_notice::decide(
                &me.to_string(),
                &org.as_uuid().to_string(),
                &grant_org.to_string(),
                is_holder,
                live,
            ) {
                return Err(if is_holder {
                    AccessError::conflict("grant_ended", "the grant is already revoked or ended")
                } else {
                    AccessError::forbidden(
                        "grant_notice_not_holder",
                        "only the grant's holder confirms its notice",
                    )
                });
            }
            let at = match noticed(tx, org, me).await?.remove(&grant.to_string()) {
                Some(at) => at,
                None => {
                    sqlx::query_scalar(
                        "INSERT INTO authz_grant_ledger
                            (org_id, user_id, grant_kind, grant_ref, event, actor_id, source, channel)
                         VALUES ($1, $2, 'ACCESS_GRANT', $3, 'NOTICE_DELIVERED', $2, 'NOTIFIER', $4)
                         RETURNING occurred_at",
                    )
                    .bind(org.as_uuid())
                    .bind(me)
                    .bind(grant.to_string())
                    .bind(CHANNEL)
                    .fetch_one(tx.as_mut())
                    .await?
                }
            };
            Ok(json!({
                "grant_id": grant, "channel": CHANNEL,
                "noticed_at": at.format(&Rfc3339).map_err(AccessError::internal)?,
            }))
        })
    })
    .await
}
