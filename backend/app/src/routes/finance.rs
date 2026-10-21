//! Finance and business: purchasing and finance, GL vouchers, sales, KPI
//! reporting, consulting engagements and the statistical projection (one
//! mount each).

use axum::Router;

use super::TenantDeps;

#[cfg(feature = "financial")]
pub(super) fn mount_financial(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    router.merge(console_financial_rest::router(
        console_financial_rest::FinancialRestState::new(
            console_financial_adapter_postgres::PgFinancialStore::new(deps.pool.clone()),
            state.jwt_verifier.clone(),
        )
        .with_passkey_step_up(state.policy_step_up.clone())
        .with_purchase_attachment_storage(state.sales_media_storage.clone()),
    ))
}

#[cfg(feature = "sales")]
pub(super) fn mount_sales(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    let mut sales_state = console_sales_rest::SalesRestState::new(
        console_sales_adapter_postgres::PgSalesStore::new(deps.pool.clone()),
        state.jwt_verifier.clone(),
    );
    if let Some(storefront_org) = state.config.storefront_org {
        sales_state = sales_state.with_storefront_org(storefront_org);
    }
    if let Some((object_store, bucket)) = state.sales_media_storage.clone() {
        sales_state = sales_state.with_media_storage(object_store, bucket);
    }
    router.merge(console_sales_rest::router(sales_state))
}

#[cfg(feature = "reporting")]
pub(super) fn mount_reporting(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_reporting_rest::router(
        console_reporting_rest::KpiRestState::new(
            console_reporting_adapter_postgres::PgKpiRepository::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "consulting")]
pub(super) fn mount_consulting(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_consulting_rest::router(
        console_consulting_rest::ConsultingRestState::new(
            deps.pool.clone(),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Accounting GL vouchers (전표): create/submit/approve/post/reverse.
#[cfg(feature = "finance-gl")]
pub(super) fn mount_finance_gl(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_finance_gl_rest::router(
        console_finance_gl_rest::FinanceGlRestState::new(
            console_finance_gl_adapter_postgres::PgVoucherStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Deterministic statistical projection (read-only, stateless).
#[cfg(feature = "analytics-quant")]
pub(super) fn mount_analytics_quant(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_analytics_quant_rest::router(
        console_analytics_quant_rest::AnalyticsQuantState::new(
            deps.pool.clone(),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}
