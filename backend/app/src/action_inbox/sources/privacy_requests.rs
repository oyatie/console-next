// SPDX-License-Identifier: LicenseRef-Proprietary
//! Open receipts reach handlers admitted by the canonical Cedar fact snapshot.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
    page_source_items,
};
use console_kernel_core::KernelError;
use console_platform_authz::{
    Principal,
    access::{NodeKind, NodeRef, cedar::PRIVACY_REQUEST_INTAKE_READ},
    cedar_pbac::visible::{EmployeePlacement, load_facts},
};
use sqlx::PgPool;
use time::{Date, OffsetDateTime, Time};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Receipt {
    id: Uuid,
    controller: String,
    receipt_no: String,
    detail: String,
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
) -> Result<ActionInboxSourcePage, KernelError> {
    let mut tx = pool.begin().await.map_err(failure)?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(failure)?;
    let facts = load_facts(&mut tx, principal.org_id, *principal.user_id.as_uuid()).await?;
    let nodes = facts
        .permitted_nodes(PRIVACY_REQUEST_INTAKE_READ)
        .map_err(failure)?;
    let _ = permission.set(!nodes.is_empty());
    if nodes.is_empty() {
        tx.commit().await.map_err(failure)?;
        return Ok(super::super::empty_source_page());
    }
    // shortcut: materialize open receipts for exact Cedar counts; push the scope filter into SQL when intake volume grows.
    let rows = sqlx::query_as::<_, Receipt>(concat!(
        "SELECT r.id, r.body#>>'{receipt,controller}' AS controller, r.body->>'receipt_no' AS receipt_no, ",
        "r.body->>'detail' AS detail, ",
        "(r.body#>>'{receipt,identity_at}')::timestamptz AS received_at, ",
        "(SELECT min((v#>>'{due,on}')::date) FROM jsonb_each(r.body->'kinds') AS k(key,v)) AS due_on, ",
        "e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.body->>'status'='RECEIVED' ",
        "AND (r.body#>>'{receipt,identity_at}')::timestamptz<=$2"
    )).bind(principal.org_id.as_uuid()).bind(query.as_of)
        .fetch_all(tx.as_mut()).await.map_err(failure)?;
    let mut items = Vec::new();
    for row in rows {
        let node = if row.controller == "TENANT" {
            EmployeePlacement {
                org_unit_id: row.org_unit_id,
                workplace_id: row.workplace_id,
                legal_entity_id: row.legal_entity_id,
            }
            .node(principal.org_id, &facts)
        } else {
            NodeRef {
                kind: NodeKind::Tenant,
                id: *principal.org_id.as_uuid(),
            }
        };
        if !facts
            .authorize(PRIVACY_REQUEST_INTAKE_READ, node)
            .map_err(failure)?
        {
            continue;
        }
        items.push(ActionInboxSourceItem {
            id: format!("privacy_request:{}", row.id),
            kind: "privacy_request".into(),
            title: if row.detail.trim().is_empty() {
                row.receipt_no.clone()
            } else {
                row.detail
            },
            ref_code: row.receipt_no,
            who: None,
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
            context: None,
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
