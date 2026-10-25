// SPDX-License-Identifier: LicenseRef-Proprietary
//! Directory follow-ups use the directory's own predicates and Cedar reach.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSource, ActionInboxSourceItem, ActionInboxSourcePage,
    ActionInboxSourceQuery,
};
use console_hr_adapter_postgres::authz::{Tier, hr_reach, hr_reach_in};
use console_hr_adapter_postgres::directory::read_filters::{
    EmployeeListFilters, EmployeeListQuery, counted_employees,
};
use console_kernel_core::{KernelError, Resolved};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use time::{Date, Duration, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};
use uuid::Uuid;

type Row = (Uuid, String, OffsetDateTime, Option<Date>);

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    source: ActionInboxSource,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let contract = source == ActionInboxSource::HrContract;
    let reach = if contract {
        hr_reach(principal, Feature::EmployeeDirectoryManage)
    } else {
        hr_reach_in(principal, Feature::EmployeeDirectoryRead, Tier::Tenant)
    };
    let Ok(reach) = reach else {
        return Ok(super::super::empty_source_page());
    };
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();
    let (namespace, kind) = match source {
        ActionInboxSource::HrIdentity => ("hr_identity", "identity_review"),
        ActionInboxSource::HrUnplaced => ("hr_unplaced", "unplaced"),
        _ => ("hr_contract", "contract_renewal"),
    };
    with_org_conn::<_, _, console_hr_adapter_postgres::HrError>(pool, org, move |tx| {
        Box::pin(async move {
            let mut input = EmployeeListQuery {
                status: Some(
                    if contract {
                        "ACTIVE,ON_LEAVE"
                    } else if source == ActionInboxSource::HrUnplaced {
                        "ACTIVE,ON_LEAVE,UNKNOWN,PRE_HIRE"
                    } else {
                        "ACTIVE,ON_LEAVE,UNKNOWN"
                    }
                    .into(),
                ),
                ..Default::default()
            };
            match source {
                ActionInboxSource::HrIdentity => input.identity_review_required = Some(true),
                ActionInboxSource::HrUnplaced => input.home_branch_review_required = Some(true),
                _ => {
                    let settings = resolve_in_tx(
                        tx.as_mut(),
                        org,
                        &[SettingKey::HrContractSoonDays],
                        None,
                        query.now,
                    )
                    .await?;
                    let days = match settings.get(&SettingKey::HrContractSoonDays) {
                        Some(Ok(Resolved {
                            value: SettingValue::Int(days),
                            ..
                        })) => *days,
                        _ => {
                            return Err(console_hr_adapter_postgres::HrError::internal(
                                "contract reminder setting unavailable",
                            ));
                        }
                    };
                    let zone = UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC);
                    input.contract_ending_before = Some(
                        (query.now.to_offset(zone).date() + Duration::days(days + 1)).to_string(),
                    );
                }
            }
            let filters = EmployeeListFilters::from_query(&input, &scope)?.with_reach(reach);
            let boundary = |q: &mut sqlx::QueryBuilder<sqlx::Postgres>| {
                q.push(" AND e.created_at <= ").push_bind(query.as_of);
            };
            let mut count = counted_employees("SELECT count(*)", &filters);
            boundary(&mut count);
            let total: i64 = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
            let select = if contract {
                "SELECT e.id, e.name, e.created_at, p.contract_end_date"
            } else {
                "SELECT e.id, e.name, e.created_at, NULL::date"
            };
            let mut sql = counted_employees(select, &filters);
            boundary(&mut sql);
            if let Some(after) = query.after {
                sql.push(" AND (e.created_at, (")
                    .push_bind(format!("{namespace}:"))
                    .push(" || e.id::text)) > (")
                    .push_bind(after.created_at)
                    .push(", ")
                    .push_bind(after.id)
                    .push(")");
            }
            sql.push(" ORDER BY e.created_at, e.id LIMIT ")
                .push_bind(i64::try_from(query.limit.saturating_add(1)).unwrap_or(201));
            let rows: Vec<Row> = sql.build_query_as().fetch_all(tx.as_mut()).await?;
            let has_more = rows.len() > query.limit;
            if source == ActionInboxSource::HrUnplaced {
                metrics::counter!("hr_unplaced_flags_emitted_total", "surface" => "inbox")
                    .increment(u64::try_from(total).unwrap_or(0));
            }
            let items = rows
                .into_iter()
                .take(query.limit)
                .map(|(id, name, created_at, due)| ActionInboxSourceItem {
                    context: Some(serde_json::json!({ "review_count": total })),
                    id: format!("{namespace}:{id}"),
                    kind: kind.into(),
                    ref_code: String::new(),
                    title: name,
                    site: None,
                    who: None,
                    due: due.map(|d| {
                        PrimitiveDateTime::new(d, Time::MAX)
                            .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC))
                    }),
                    submitted: None,
                    created_at,
                    links: vec![ActionInboxLink {
                        kind: "employee".into(),
                        id: id.to_string(),
                        label: None,
                    }],
                })
                .collect();
            Ok(ActionInboxSourcePage {
                items,
                total: usize::try_from(total).unwrap_or(0),
                total_is_exact: true,
                has_more,
            })
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = ?e, "directory inbox source failed");
        KernelError::internal("failed to load action inbox")
    })
}
