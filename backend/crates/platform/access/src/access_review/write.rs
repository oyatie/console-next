// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::Principal;
use console_platform_db::{
    idempotency::{self, IdempotencyClaim},
    with_audits,
};
use serde_json::json;
use sqlx::Row;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::{
    AccessReviewDecisionInput, AccessReviewDecisionKind, AccessReviewDetail, lock_period,
    parse_quarter, quarter_due_at, read::load_detail_in_tx, require_review_access, review_event,
};
use crate::{AccessError, AccessResult, AccessService};

const OP_START: &str = "access_review.start";
const OP_DECIDE: &str = "access_review.decide";

pub async fn start(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
) -> AccessResult<AccessReviewDetail> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, true).await?;
            let (year, q) = parse_quarter(&period)?;
            let key = idempotency::validate_idempotency_key(Some(&key))
                .map_err(|m| AccessError::invalid("validation", m))?;
            match idempotency::claim_idempotency_key(tx, OP_START, &key, &json!({"period": period}))
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
            let existing: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM access_reviews WHERE org_id = $1 AND period = $2",
            )
            .bind(p.org_id.as_uuid())
            .bind(&period)
            .fetch_optional(tx.as_mut())
            .await?;

            let mut audits = Vec::new();
            if existing.is_none() {
                let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
                    .fetch_one(tx.as_mut())
                    .await?;
                let due_at = quarter_due_at(year, q)?;
                let grant_rows = sqlx::query(
                    "SELECT g.id, g.account_id, COALESCE(u.display_name, g.account_id::text) AS account_name,
                            e.employee_number, e.org_unit AS unit_name, u.is_active AS account_active,
                            g.role_id, r.name_ko AS role_name_ko, g.scope_kind, g.include_descendants,
                            COALESCE(g.legal_entity_id, g.workplace_id, g.org_unit_id) AS scope_node_id,
                            access_review_scope_name(g.org_id, g.scope_kind,
                                COALESCE(g.legal_entity_id, g.workplace_id, g.org_unit_id), $2) AS scope_name,
                            g.valid_from, g.valid_to,
                            (SELECT max(a.created_at) FROM audit_events a
                              WHERE a.org_id = g.org_id AND a.actor = g.account_id) AS last_used_at
                       FROM access_grants g
                       JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id
                       JOIN person_accounts_current u ON u.org_id = g.org_id AND u.id = g.account_id
                       LEFT JOIN employees e ON e.org_id = u.org_id AND e.id = u.employee_id
                      WHERE g.org_id = $1
                        AND g.status IN ('ACTIVE', 'PENDING')
                        AND (g.valid_to IS NULL OR g.valid_to > $2)
                      ORDER BY account_name, g.id",
                )
                .bind(p.org_id.as_uuid())
                .bind(now)
                .fetch_all(tx.as_mut())
                .await?;

                let review_id = Uuid::new_v4();
                let frozen_count = i32::try_from(grant_rows.len()).unwrap_or(i32::MAX);
                sqlx::query(
                    "INSERT INTO access_reviews (org_id, id, period, state, due_at, frozen_count, started_by, started_at)
                     VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7)",
                )
                .bind(p.org_id.as_uuid())
                .bind(review_id)
                .bind(&period)
                .bind(due_at)
                .bind(frozen_count)
                .bind(p.user_id.as_uuid())
                .bind(now)
                .execute(tx.as_mut())
                .await?;

                for row in grant_rows {
                    let scope_kind: String = row.try_get("scope_kind")?;
                    let account_active: bool = row.try_get("account_active")?;
                    let valid_to: Option<OffsetDateTime> = row.try_get("valid_to")?;
                    let last_used_at: Option<OffsetDateTime> = row.try_get("last_used_at")?;

                    let mut signals = Vec::new();
                    if scope_kind == "TENANT" {
                        signals.push("wide_scope".to_owned());
                    }
                    if last_used_at.is_none_or(|t| t < now - Duration::days(90)) {
                        signals.push("unused_90d".to_owned());
                    }
                    if valid_to.is_some_and(|t| t <= now + Duration::days(30)) {
                        signals.push("expiring_soon".to_owned());
                    }
                    if !account_active {
                        signals.push("inactive_account".to_owned());
                    }

                    sqlx::query(
                        "INSERT INTO access_review_items
                            (org_id, id, review_id, grant_id, account_id, account_name, employee_number,
                             unit_name, role_id, role_name_ko, scope_kind, scope_label, valid_from,
                             valid_to, last_used_at, signals, scope_node_id, scope_include_descendants)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
                    )
                    .bind(p.org_id.as_uuid())
                    .bind(Uuid::new_v4())
                    .bind(review_id)
                    .bind(row.try_get::<Uuid, _>("id")?)
                    .bind(row.try_get::<Uuid, _>("account_id")?)
                    .bind(row.try_get::<String, _>("account_name")?)
                    .bind(row.try_get::<Option<String>, _>("employee_number")?)
                    .bind(row.try_get::<Option<String>, _>("unit_name")?)
                    .bind(row.try_get::<Uuid, _>("role_id")?)
                    .bind(row.try_get::<String, _>("role_name_ko")?)
                    .bind(&scope_kind)
                    .bind(row.try_get::<Option<String>, _>("scope_name")?.as_deref().unwrap_or(&scope_kind))
                    .bind(row.try_get::<OffsetDateTime, _>("valid_from")?)
                    .bind(valid_to)
                    .bind(last_used_at)
                    .bind(&signals)
                    .bind(row.try_get::<Option<Uuid>, _>("scope_node_id")?)
                    .bind(row.try_get::<bool, _>("include_descendants")?)
                    .execute(tx.as_mut())
                    .await?;
                }

                audits.push(review_event(&p, &period, OP_START)?.with_snapshots(
                    None,
                    Some(json!({"period": period, "frozen_count": frozen_count})),
                ));
            }

            let detail = load_detail_in_tx(tx, &p, &period).await?;
            let val = serde_json::to_value(&detail).map_err(AccessError::internal)?;
            idempotency::complete_idempotency_key(tx, OP_START, &key, &val).await?;
            console_platform_db::command_outcomes::set_result(tx, &val).await?;
            Ok((detail, audits))
        })
    })
    .await
}

pub async fn decide(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
    body: AccessReviewDecisionInput,
) -> AccessResult<AccessReviewDetail> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, true).await?;
            parse_quarter(&period)?;
            let reason_code = body
                .reason_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if body.decision == AccessReviewDecisionKind::Revoke && reason_code.is_none() {
                return Err(AccessError::invalid(
                    "reason_required",
                    "revocation requires a reason code",
                ));
            }
            let reason_note = body
                .reason_note
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);

            let key = idempotency::validate_idempotency_key(Some(&key))
                .map_err(|m| AccessError::invalid("validation", m))?;
            let req_hash = json!({"period": period, "body": body});
            match idempotency::claim_idempotency_key(tx, OP_DECIDE, &key, &req_hash).await? {
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
                "SELECT id, state FROM access_reviews WHERE org_id = $1 AND period = $2",
            )
            .bind(p.org_id.as_uuid())
            .bind(&period)
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| AccessError::not_found("review_not_started", "review has not started"))?;

            let review_id: Uuid = review_row.try_get("id")?;
            let state: String = review_row.try_get("state")?;
            if state == "COMPLETE" {
                return Err(AccessError::conflict(
                    "review_already_complete",
                    "completed review cannot accept decisions",
                ));
            }

            let account_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT account_id FROM access_review_items
                  WHERE org_id = $1 AND review_id = $2 AND id = $3",
            )
            .bind(p.org_id.as_uuid())
            .bind(review_id)
            .bind(body.item_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let account_id = account_id.ok_or_else(|| {
                AccessError::not_found("review_item_not_found", "review item not found")
            })?;
            if account_id == *p.user_id.as_uuid() {
                return Err(AccessError::forbidden(
                    "self_review_forbidden",
                    "cannot decide own role grant in access review",
                ));
            }

            sqlx::query(
                "INSERT INTO access_review_decisions
                    (org_id, id, review_id, item_id, decision, reason_code, reason_note, decided_by, decided_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
                 ON CONFLICT (org_id, review_id, item_id) DO UPDATE SET
                    decision = EXCLUDED.decision,
                    reason_code = EXCLUDED.reason_code,
                    reason_note = EXCLUDED.reason_note,
                    decided_by = EXCLUDED.decided_by,
                    decided_at = now()",
            )
            .bind(p.org_id.as_uuid())
            .bind(Uuid::new_v4())
            .bind(review_id)
            .bind(body.item_id)
            .bind(body.decision.as_str())
            .bind(&reason_code)
            .bind(&reason_note)
            .bind(p.user_id.as_uuid())
            .execute(tx.as_mut())
            .await?;

            let ev = review_event(&p, &period, OP_DECIDE)?.with_snapshots(
                None,
                Some(json!({
                    "item_id": body.item_id,
                    "decision": body.decision,
                    "reason_code": reason_code,
                })),
            );
            let detail = load_detail_in_tx(tx, &p, &period).await?;
            let val = serde_json::to_value(&detail).map_err(AccessError::internal)?;
            idempotency::complete_idempotency_key(tx, OP_DECIDE, &key, &val).await?;
            console_platform_db::command_outcomes::set_result(tx, &val).await?;
            Ok((detail, vec![ev]))
        })
    })
    .await
}
