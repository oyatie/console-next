// SPDX-License-Identifier: LicenseRef-Proprietary
//! Directory membership matches the org-unit preview for both placement representations.

use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use futures::StreamExt;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::fixtures::{fixture, site};
use super::support::{employee, principal, query, tenant, user};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_and_bound_joiners_share_list_total_facets_and_export(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let unit = site(&pool, t.org, *actor.as_uuid(), "Membership").await;
    let foreign = tenant(&pool).await;
    let mut expected = Vec::new();
    for (name, status, org, placement) in [
        ("Legacy", "PRE_HIRE", t.org, "legacy"),
        ("Bound", "PRE_HIRE", t.org, "bound"),
        ("Both", "PRE_HIRE", t.org, "both"),
        ("Active", "ACTIVE", t.org, "legacy"),
        ("Exited", "EXITED", t.org, "legacy"),
        ("Other", "PRE_HIRE", t.org, "other"),
        ("NameOnly", "PRE_HIRE", t.org, "name"),
        ("Foreign", "PRE_HIRE", foreign.org, "legacy"),
    ] {
        let id = employee(&pool, org, name, name, status).await;
        let sql = match placement {
            "bound" => {
                "UPDATE employees SET org_unit_id = $3, org_unit = 'Membership' WHERE org_id = $1 AND id = $2"
            }
            "both" => {
                "UPDATE employees SET org_unit_id = $3, org_unit = $3::text WHERE org_id = $1 AND id = $2"
            }
            "name" => {
                "UPDATE employees SET org_unit = 'Membership' WHERE org_id = $1 AND id = $2 AND $3::uuid IS NOT NULL"
            }
            _ => "UPDATE employees SET org_unit = $3::text WHERE org_id = $1 AND id = $2",
        };
        let placed = if placement == "other" {
            Uuid::new_v4()
        } else {
            unit
        };
        fixture(&pool, sql, org, &[id, placed]).await;
        if org == t.org && status == "PRE_HIRE" && matches!(placement, "legacy" | "bound" | "both")
        {
            expected.push(id);
        }
    }
    let reader = || principal(t.org, actor);
    let filter =
        || query(json!({ "org_unit_id": unit, "status": "PRE_HIRE", "sort": "name", "limit": 2 }));
    let first = t.hr.list_employees(reader(), filter()).await.unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(
        first
            .items
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["Both", "Bound"]
    );
    let second = t.hr.list_employees(reader(), query(json!({
        "org_unit_id": unit, "status": "PRE_HIRE", "cursor": first.next_cursor.unwrap(), "limit": 2,
    }))).await.unwrap();
    assert_eq!(second.total, 3);
    assert_eq!(
        second
            .items
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["Legacy"]
    );
    let mut listed = first
        .items
        .iter()
        .chain(&second.items)
        .map(|e| e.id)
        .collect::<Vec<_>>();
    listed.sort();
    expected.sort();
    assert_eq!(listed, expected);
    let facets = t.hr.employee_facets(reader(), filter()).await.unwrap();
    assert_eq!(facets.total, 3);
    assert_eq!(
        facets
            .status
            .iter()
            .find(|f| f.value.as_deref() == Some("PRE_HIRE"))
            .unwrap()
            .count,
        3
    );

    let (_, chunks) =
        t.hr.export_employees_csv(
            reader(),
            filter(),
            ExportPurposeQuery {
                export_purpose: Some("INTERNAL_REVIEW".to_owned()),
                layout: None,
            },
        )
        .await
        .unwrap();
    let body = chunks
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    assert_eq!(body.trim_end().split("\r\n").count(), 4);
    for name in ["Legacy", "Bound", "Both"] {
        assert!(body.contains(name), "{body}");
    }
    for name in ["Active", "Exited", "Other", "NameOnly", "Foreign"] {
        assert!(!body.contains(name), "{body}");
    }
}
