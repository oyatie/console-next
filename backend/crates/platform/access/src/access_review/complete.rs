// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::Principal;
use console_platform_db::{
    idempotency::{self, IdempotencyClaim},
    with_audits,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use super::{
    AccessReviewDetail, lock_period, parse_quarter, read::load_detail_in_tx, require_review_access,
    review_event,
};
use crate::{
    AccessError, AccessResult, AccessService, StepUp,
    actor::{audit, verify_step_up},
    grants_store,
};

const OP_COMPLETE: &str = "access_review.complete";

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteReviewInput {
    #[serde(default)]
    pub step_up: Option<StepUp>,
}

pub async fn complete(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
    step_up: Option<StepUp>,
) -> AccessResult<AccessReviewDetail> {
    verify_step_up(s, &p, step_up).await?;
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, true).await?;
            parse_quarter(&period)?;
            let key = idempotency::validate_idempotency_key(Some(&key))
                .map_err(|m| AccessError::invalid("validation", m))?;
            match idempotency::claim_idempotency_key(
                tx,
                OP_COMPLETE,
                &key,
                &json!({"period": period}),
            )
            .await?
            {
                IdempotencyClaim::Replay(val) => {
                    let detail: AccessReviewDetail =
                        serde_json::from_value(val).map_err(AccessError::internal)?;
                    return Ok((detail, Vec::new()));
                }
                IdempotencyClaim::Mismatch => {
                    return Err(console_kernel_core::KernelError::conflict(
                        idempotency::IDEMPOTENCY_KEY_REUSED,
                    )
                    .into());
                }
                IdempotencyClaim::Fresh => {}
            }

            lock_period(tx, &p, &period).await?;
            let review_row = sqlx::query(
                "SELECT id, state, frozen_count FROM access_reviews WHERE org_id = $1 AND period = $2",
            )
            .bind(p.org_id.as_uuid())
            .bind(&period)
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| AccessError::not_found("review_not_started", "review has not started"))?;

            let review_id: Uuid = review_row.try_get("id")?;
            let state: String = review_row.try_get("state")?;
            let frozen_count: i32 = review_row.try_get("frozen_count")?;

            let mut audits = Vec::new();
            if state != "COMPLETE" {
                let decided_count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM access_review_decisions WHERE org_id = $1 AND review_id = $2",
                )
                .bind(p.org_id.as_uuid())
                .bind(review_id)
                .fetch_one(tx.as_mut())
                .await?;
                if decided_count < i64::from(frozen_count) {
                    return Err(AccessError::conflict(
                        "review_incomplete",
                        "all frozen grants must have a decision before completing the review",
                    ));
                }

                let revocations: Vec<(Uuid, Uuid)> = sqlx::query_as(
                    "SELECT d.id, i.grant_id
                       FROM access_review_decisions d
                       JOIN access_review_items i
                         ON i.org_id = d.org_id AND i.review_id = d.review_id AND i.id = d.item_id
                      WHERE d.org_id = $1 AND d.review_id = $2 AND d.decision = 'REVOKE'
                      ORDER BY i.grant_id",
                )
                .bind(p.org_id.as_uuid())
                .bind(review_id)
                .fetch_all(tx.as_mut())
                .await?;

                let mut revoked_count = 0;
                for (decision_id, grant_id) in &revocations {
                    let grant = grants_store::grant_row(tx, p.org_id, *grant_id, true)
                        .await?
                        .ok_or_else(|| AccessError::not_found("grant_not_found", "reviewed grant not found"))?;
                    if !grant.revoked {
                        grants_store::revoke(tx, p.org_id, *grant_id, *p.user_id.as_uuid()).await?;
                        audits.push(audit(&p, "access.grant.revoke", "access_grant", *grant_id)?);
                        revoked_count += 1;
                    }
                    sqlx::query(
                        "UPDATE access_review_decisions SET applied_at = now()
                          WHERE org_id = $1 AND id = $2",
                    )
                    .bind(p.org_id.as_uuid())
                    .bind(decision_id)
                    .execute(tx.as_mut())
                    .await?;
                }

                sqlx::query(
                    "UPDATE access_reviews
                        SET state = 'COMPLETE', completed_by = $3, completed_at = now()
                      WHERE org_id = $1 AND id = $2",
                )
                .bind(p.org_id.as_uuid())
                .bind(review_id)
                .bind(p.user_id.as_uuid())
                .execute(tx.as_mut())
                .await?;

                audits.push(review_event(&p, &period, OP_COMPLETE)?.with_snapshots(
                    None,
                    Some(json!({
                        "period": period,
                        "frozen_count": frozen_count,
                        "revoked_count": revoked_count,
                    })),
                ));
            }

            let detail = load_detail_in_tx(tx, &p, &period).await?;
            let val = serde_json::to_value(&detail).map_err(AccessError::internal)?;
            idempotency::complete_idempotency_key(tx, OP_COMPLETE, &key, &val).await?;
            console_platform_db::command_outcomes::set_result(tx, &val).await?;
            Ok((detail, audits))
        })
    })
    .await
}
