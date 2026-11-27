// SPDX-License-Identifier: LicenseRef-Proprietary
//! Open privacy receipts reach only handlers who can actually decide them (BG-9).
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
    page_source_items,
};
use console_kernel_core::KernelError;
use console_platform_authz::{
    Feature, Principal,
    cedar_pbac::{actions::independent_people, visible::EmployeePlacement},
};
use serde_json::Value;
use sqlx::PgPool;
use time::{Date, OffsetDateTime, Time};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Receipt {
    id: Uuid,
    subject_user_id: Uuid,
    body: Value,
    receipt_no: String,
    subject_name: String,
    kinds: Value,
    received_at: OffsetDateTime,
    due_on: Option<Date>,
    org_unit_id: Option<Uuid>,
    workplace_id: Option<Uuid>,
    legal_entity_id: Option<Uuid>,
}

fn failure(error: impl std::fmt::Display) -> KernelError {
    super::super::source_failure("privacy_requests", error)
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
    permission: &tokio::sync::OnceCell<bool>,
    authorization: &console_platform_request_context::Authorization,
) -> Result<ActionInboxSourcePage, KernelError> {
    let mut tx = pool.begin().await.map_err(failure)?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(failure)?;
    let facts = authorization
        .get_in(&mut tx, principal.org_id, *principal.user_id.as_uuid())
        .await?;
    let nodes = facts
        .permitted_nodes(Feature::PrivacyRequestDecide.as_str())
        .map_err(failure)?;
    let _ = permission.set(!nodes.is_empty());
    if nodes.is_empty() {
        tx.commit().await.map_err(failure)?;
        return Ok(super::super::empty_source_page());
    }
    let rows = sqlx::query_as::<_, Receipt>(concat!(
        "SELECT r.id, r.subject_user_id, r.body, r.body->>'receipt_no' AS receipt_no, p.display_name AS subject_name, ",
        "(SELECT jsonb_agg(key ORDER BY key) FROM jsonb_object_keys(r.body->'kinds') key) AS kinds, ",
        "(r.body#>>'{receipt,identity_at}')::timestamptz AS received_at, ",
        "(SELECT min((v#>>'{due,on}')::date) FROM jsonb_each(r.body->'kinds') AS k(key,v)) AS due_on, ",
        "e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "JOIN person_accounts_current p ON p.org_id=r.org_id AND p.id=r.subject_user_id ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.body->>'status'='RECEIVED' ",
        "AND r.body#>>'{receipt,controller}'='TENANT' ",
        "AND (r.body#>>'{receipt,identity_at}')::timestamptz<=$2"
    ))
    .bind(principal.org_id.as_uuid())
    .bind(query.as_of)
    .fetch_all(tx.as_mut())
    .await
    .map_err(failure)?;

    let checker = *principal.user_id.as_uuid();
    let mut items = Vec::new();
    for row in rows {
        let node = EmployeePlacement {
            org_unit_id: row.org_unit_id,
            workplace_id: row.workplace_id,
            legal_entity_id: row.legal_entity_id,
        }
        .node(principal.org_id, &facts);
        if !facts
            .authorize(Feature::PrivacyRequestDecide.as_str(), node)
            .map_err(failure)?
        {
            continue;
        }
        let filed_by = row
            .body
            .get("filed_by")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok());
        let objection_of = row
            .body
            .get("objection_of")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok());
        let original_decided_by = if let Some(orig_id) = objection_of {
            let orig_body: Option<Value> = sqlx::query_scalar(
                "SELECT body FROM privacy_rights_requests WHERE org_id=$1 AND id=$2",
            )
            .bind(principal.org_id.as_uuid())
            .bind(orig_id)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(failure)?;
            orig_body.and_then(|body| {
                body.get("decided_by")
                    .and_then(Value::as_str)
                    .and_then(|s| Uuid::parse_str(s).ok())
            })
        } else {
            None
        };
        let (allowed, _) = facts
            .authorize_privacy_request_decide(
                node,
                row.subject_user_id,
                filed_by,
                original_decided_by,
            )
            .map_err(failure)?;
        if !allowed {
            continue;
        }
        if independent_people::refusal_in_tx(tx.as_mut(), Some(row.subject_user_id), checker)
            .await
            .is_some()
        {
            continue;
        }
        if let Some(filer) = filed_by.filter(|f| *f != row.subject_user_id)
            && independent_people::refusal_in_tx(tx.as_mut(), Some(filer), checker)
                .await
                .is_some()
        {
            continue;
        }
        if let Some(orig_decider) = original_decided_by
            && independent_people::refusal_in_tx(tx.as_mut(), Some(orig_decider), checker)
                .await
                .is_some()
        {
            continue;
        }

        items.push(ActionInboxSourceItem {
            due_basis: row
                .due_on
                .map(|_| console_action_inbox_application::DueBasis::Statutory),
            id: format!("privacy_request:{}", row.id),
            kind: "privacy_request".into(),
            title: row.receipt_no.clone(),
            ref_code: row.receipt_no,
            who: Some(row.subject_name),
            due: row.due_on.map(|on| {
                on.with_time(Time::MAX)
                    .assume_offset(time::macros::offset!(+9))
            }),
            submitted: Some(row.received_at),
            created_at: row.received_at,
            links: vec![ActionInboxLink {
                kind: "privacy_request".into(),
                id: row.id.to_string(),
                label: None,
            }],
            site: None,
            context: Some(serde_json::json!({"privacy_kinds": row.kinds})),
        });
    }
    tx.commit().await.map_err(failure)?;
    let total = items.len();
    let (items, has_more) = page_source_items(items, &query);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}
