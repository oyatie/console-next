// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Directory statuses, filters and facets share the chart's employment boundary.

mod support;

use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, EntityScope};
use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use console_kernel_core::{OrgId, TraceContext};
use futures::StreamExt;
use serde_json::json;
use sqlx::PgPool;
use support::{employee, no_filters, principal, query, tenant, user};
use time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn directory_statuses_filters_and_facets_follow_the_same_count_rule_as_the_chart(
    owner: PgPool,
) {
    let today = today_kst();
    for (stored, hire, last_day, expected, employed) in [
        ("ACTIVE", today + Duration::days(1), None, "PRE_HIRE", 0),
        (
            "EXITED",
            today - Duration::days(30),
            Some(today),
            "ACTIVE",
            1,
        ),
        (
            "ACTIVE",
            today - Duration::days(30),
            Some(today - Duration::days(1)),
            "EXITED",
            0,
        ),
        ("ON_LEAVE", today - Duration::days(30), None, "ON_LEAVE", 1),
        ("PRE_HIRE", today, None, "ACTIVE", 1),
        ("UNKNOWN", today - Duration::days(30), None, "UNKNOWN", 1),
    ] {
        let t = tenant(&owner).await;
        let id = employee(&owner, t.org, "김기준", "COUNT-1", stored).await;
        sqlx::query("UPDATE employees SET hire_date=$2,exit_date=$3 WHERE id=$1")
            .bind(id)
            .bind(hire.to_string())
            .bind(last_day.map(|day| day.to_string()))
            .execute(&owner)
            .await
            .unwrap();
        let actor = user(&owner, t.org, None).await;
        let reader = || principal(t.org, actor);
        let detail = t.hr.employee_detail(reader(), id).await.unwrap();
        if stored == "EXITED" {
            assert!(
                !detail
                    .allowed_events
                    .iter()
                    .any(|action| action.event_type == "TRANSFER")
            );
        } else if stored == "ACTIVE" {
            assert!(
                detail
                    .allowed_events
                    .iter()
                    .any(|action| action.event_type == "TRANSFER")
            );
        }
        let page = t.hr.list_employees(reader(), no_filters()).await.unwrap();
        assert_eq!(page.total, 1);
        for row in [&detail.employee, &page.items[0]] {
            assert_eq!(
                row.status.as_deref(),
                Some(expected),
                "stored {stored}, hire {hire}, last {last_day:?}"
            );
        }
        let (_, chunks) =
            t.hr.export_employees_csv(
                reader(),
                no_filters(),
                ExportPurposeQuery {
                    export_purpose: Some("INTERNAL_REVIEW".into()),
                    layout: None,
                },
            )
            .await
            .unwrap();
        let csv = chunks
            .map(|part| part.unwrap())
            .collect::<Vec<_>>()
            .await
            .concat();
        assert_eq!(
            csv.lines().nth(1).unwrap().split(',').nth(9),
            Some(expected)
        );
        let active =
            t.hr.list_employees(reader(), query(json!({ "status": "ACTIVE" })))
                .await
                .unwrap();
        assert_eq!(active.total, i64::from(expected == "ACTIVE"));
        let facets =
            t.hr.employee_facets(reader(), query(json!({ "status": "ACTIVE" })))
                .await
                .unwrap();
        assert_eq!(facets.total, active.total);
        assert_eq!(
            facets
                .status
                .iter()
                .map(|f| (f.value.as_deref(), f.count))
                .collect::<Vec<_>>(),
            vec![(Some(expected), 1)]
        );
        let current =
            t.hr.list_employees(
                reader(),
                query(json!({ "status": "ACTIVE,ON_LEAVE,UNKNOWN" })),
            )
            .await
            .unwrap();
        assert_eq!(current.total, employed);
        let store =
            PgEntityStore::new(console_platform_test_support::runtime_role_pool(&owner).await);
        let chart = store
            .org_structure(&Actor {
                org: OrgId::from_uuid(t.org),
                user: actor,
                trace: TraceContext::generate(),
                command_id: None,
                scope: EntityScope::Tenant,
            })
            .await
            .unwrap();
        assert_eq!(
            chart.entity_unknown_headcount,
            Some(current.total),
            "chart population for {stored}"
        );
    }
}
