// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde::Deserialize;
use sqlx::{Postgres, Row, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{
    AccessReviewDetail, AccessReviewItemOut, AccessReviewSummary, current_and_next_quarters,
    parse_quarter, quarter_due_at, require_review_access, review_event,
};
use crate::{AccessError, AccessResult, AccessService};

#[derive(Debug, Default, Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    pub export_purpose: Option<String>,
}

pub async fn list(s: &AccessService, p: Principal) -> AccessResult<Vec<AccessReviewSummary>> {
    with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, false).await?;
            let rows = sqlx::query(
                "SELECT r.id, r.period, r.state, r.due_at, r.frozen_count, r.started_at, r.completed_at,
                        count(d.id) AS decided_count,
                        count(d.id) FILTER (WHERE d.decision = 'KEEP') AS keep_count,
                        count(d.id) FILTER (WHERE d.decision = 'REVOKE') AS revoke_count,
                        count(DISTINCT d.decided_by) AS reviewer_count
                   FROM access_reviews r
                   LEFT JOIN access_review_decisions d
                     ON d.org_id = r.org_id AND d.review_id = r.id
                  WHERE r.org_id = $1
                  GROUP BY r.org_id, r.id
                  ORDER BY r.period DESC",
            )
            .bind(p.org_id.as_uuid())
            .fetch_all(tx.as_mut())
            .await?;

            let mut out = Vec::new();
            for row in rows {
                out.push(AccessReviewSummary {
                    id: Some(row.try_get("id")?),
                    period: row.try_get("period")?,
                    state: row.try_get("state")?,
                    due_at: row.try_get("due_at")?,
                    frozen_count: row.try_get("frozen_count")?,
                    decided_count: row.try_get("decided_count")?,
                    keep_count: row.try_get("keep_count")?,
                    revoke_count: row.try_get("revoke_count")?,
                    reviewer_count: row.try_get("reviewer_count")?,
                    started_at: row.try_get("started_at")?,
                    completed_at: row.try_get("completed_at")?,
                });
            }

            let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
                .fetch_one(tx.as_mut())
                .await?;
            let (cur_q, next_q) = current_and_next_quarters(now);
            for (period, state) in [(next_q, "UPCOMING"), (cur_q, "UNSTARTED")] {
                if !out.iter().any(|r| r.period == period)
                    && let Ok((y, q)) = parse_quarter(&period)
                    && let Ok(due_at) = quarter_due_at(y, q)
                {
                    out.push(AccessReviewSummary {
                        id: None,
                        period,
                        state: state.to_owned(),
                        due_at,
                        frozen_count: 0,
                        decided_count: 0,
                        keep_count: 0,
                        revoke_count: 0,
                        reviewer_count: 0,
                        started_at: None,
                        completed_at: None,
                    });
                }
            }
            out.sort_by(|a, b| b.period.cmp(&a.period));
            Ok(out)
        })
    })
    .await
}

pub async fn get(
    s: &AccessService,
    p: Principal,
    period: String,
) -> AccessResult<AccessReviewDetail> {
    with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, false).await?;
            load_detail_in_tx(tx, &p, &period).await
        })
    })
    .await
}

pub(super) async fn load_detail_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    period: &str,
) -> AccessResult<AccessReviewDetail> {
    let (year, q) = parse_quarter(period)?;
    let head = sqlx::query(
        "SELECT r.id, r.period, r.state, r.due_at, r.frozen_count, r.started_at, r.completed_at,
                count(d.id) AS decided_count,
                count(d.id) FILTER (WHERE d.decision = 'KEEP') AS keep_count,
                count(d.id) FILTER (WHERE d.decision = 'REVOKE') AS revoke_count,
                count(DISTINCT d.decided_by) AS reviewer_count
           FROM access_reviews r
           LEFT JOIN access_review_decisions d
             ON d.org_id = r.org_id AND d.review_id = r.id
          WHERE r.org_id = $1 AND r.period = $2
          GROUP BY r.org_id, r.id",
    )
    .bind(p.org_id.as_uuid())
    .bind(period)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some(head) = head else {
        return Ok(AccessReviewDetail {
            summary: AccessReviewSummary {
                id: None,
                period: period.to_owned(),
                state: "UNSTARTED".to_owned(),
                due_at: quarter_due_at(year, q)?,
                frozen_count: 0,
                decided_count: 0,
                keep_count: 0,
                revoke_count: 0,
                reviewer_count: 0,
                started_at: None,
                completed_at: None,
            },
            items: Vec::new(),
        });
    };

    let review_id: Uuid = head.try_get("id")?;
    let rows = sqlx::query(
        "SELECT i.id, i.grant_id, i.account_id, i.account_name, i.employee_number, i.unit_name,
                i.role_id, i.role_name_ko, i.scope_kind,
                CASE WHEN i.scope_include_descendants IS NULL THEN COALESCE(
                    access_review_scope_name(i.org_id, i.scope_kind,
                        COALESCE(g.legal_entity_id, g.workplace_id, g.org_unit_id), $3), i.scope_label)
                    ELSE i.scope_label END AS scope_label,
                COALESCE(i.scope_node_id, g.legal_entity_id, g.workplace_id, g.org_unit_id) AS scope_node_id,
                COALESCE(i.scope_include_descendants, g.include_descendants) AS scope_include_descendants,
                i.valid_from, i.valid_to,
                i.last_used_at, i.signals,
                d.decision, d.reason_code, d.reason_note, d.decided_by,
                u.display_name AS decided_by_name, d.decided_at, d.applied_at
           FROM access_review_items i
           LEFT JOIN access_grants g ON i.scope_include_descendants IS NULL
             AND g.org_id = i.org_id AND g.id = i.grant_id
           LEFT JOIN access_review_decisions d
             ON d.org_id = i.org_id AND d.review_id = i.review_id AND d.item_id = i.id
           LEFT JOIN person_accounts_current u
             ON u.org_id = d.org_id AND u.id = d.decided_by
          WHERE i.org_id = $1 AND i.review_id = $2
          ORDER BY (cardinality(i.signals) > 0) DESC, i.account_name, i.id",
    )
    .bind(p.org_id.as_uuid())
    .bind(review_id)
    .bind(head.try_get::<OffsetDateTime, _>("started_at")?)
    .fetch_all(tx.as_mut())
    .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(AccessReviewItemOut {
            id: row.try_get("id")?,
            grant_id: row.try_get("grant_id")?,
            account_id: row.try_get("account_id")?,
            account_name: row.try_get("account_name")?,
            employee_number: row.try_get("employee_number")?,
            unit_name: row.try_get("unit_name")?,
            role_id: row.try_get("role_id")?,
            role_name_ko: row.try_get("role_name_ko")?,
            scope_kind: row.try_get("scope_kind")?,
            scope_label: row.try_get("scope_label")?,
            scope_node_id: row.try_get("scope_node_id")?,
            scope_include_descendants: row.try_get("scope_include_descendants")?,
            valid_from: row.try_get("valid_from")?,
            valid_to: row.try_get("valid_to")?,
            last_used_at: row.try_get("last_used_at")?,
            signals: row.try_get("signals")?,
            decision: row.try_get("decision")?,
            reason_code: row.try_get("reason_code")?,
            reason_note: row.try_get("reason_note")?,
            decided_by: row.try_get("decided_by")?,
            decided_by_name: row.try_get("decided_by_name")?,
            decided_at: row.try_get("decided_at")?,
            applied_at: row.try_get("applied_at")?,
        });
    }

    Ok(AccessReviewDetail {
        summary: AccessReviewSummary {
            id: Some(review_id),
            period: head.try_get("period")?,
            state: head.try_get("state")?,
            due_at: head.try_get("due_at")?,
            frozen_count: head.try_get("frozen_count")?,
            decided_count: head.try_get("decided_count")?,
            keep_count: head.try_get("keep_count")?,
            revoke_count: head.try_get("revoke_count")?,
            reviewer_count: head.try_get("reviewer_count")?,
            started_at: head.try_get("started_at")?,
            completed_at: head.try_get("completed_at")?,
        },
        items,
    })
}

fn csv_cell(raw: &str) -> String {
    let guarded = if raw.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{raw}")
    } else {
        raw.to_owned()
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

pub async fn export_csv(
    s: &AccessService,
    p: Principal,
    period: String,
    q: ExportQuery,
) -> AccessResult<String> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require_review_access(tx, &p, false).await?;
            let detail = load_detail_in_tx(tx, &p, &period).await?;
            let mut lines = vec![
                "account_name,employee_number,unit_name,role_name,scope,valid_from,valid_to,signals,decision,reason_code,decided_by,scope_kind,scope_node_id,scope_include_descendants"
                    .to_owned(),
            ];
            for item in &detail.items {
                let valid_from = item.valid_from.format(&Rfc3339).unwrap_or_default();
                let valid_to = item
                    .valid_to
                    .and_then(|d| d.format(&Rfc3339).ok())
                    .unwrap_or_default();
                let row = [
                    csv_cell(&item.account_name),
                    csv_cell(item.employee_number.as_deref().unwrap_or("")),
                    csv_cell(item.unit_name.as_deref().unwrap_or("")),
                    csv_cell(&item.role_name_ko),
                    csv_cell(&item.scope_label),
                    csv_cell(&valid_from),
                    csv_cell(&valid_to),
                    csv_cell(&item.signals.join(";")),
                    csv_cell(item.decision.as_deref().unwrap_or("UNDECIDED")),
                    csv_cell(item.reason_code.as_deref().unwrap_or("")),
                    csv_cell(item.decided_by_name.as_deref().unwrap_or("")),
                    csv_cell(&item.scope_kind),
                    item.scope_node_id.map(|id| id.to_string()).unwrap_or_default(),
                    item.scope_include_descendants.map(|v| v.to_string()).unwrap_or_default(),
                ]
                .join(",");
                lines.push(row);
            }
            let purpose = q
                .export_purpose
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("PERIODIC_ACCESS_REVIEW");
            let ev = review_event(&p, &period, "access_review.export")?.with_snapshots(
                None,
                Some(serde_json::json!({
                    "row_count": detail.items.len(),
                    "export_purpose": purpose,
                })),
            );
            Ok((format!("\u{feff}{}\n", lines.join("\n")), vec![ev]))
        })
    })
    .await
}
