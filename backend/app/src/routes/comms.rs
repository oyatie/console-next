//! Communication: messenger, notifications, inbox, notices, to-dos, support
//! and webmail (one mount each).

use axum::Router;

use super::TenantDeps;

#[cfg(feature = "support")]
pub(super) fn mount_support(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    let mut support_state = console_support_rest::SupportRestState::new(
        console_support_adapter_postgres::PgSupportStore::new(deps.pool.clone()),
        state.jwt_verifier.clone(),
        state.push_notifier.clone(),
    );
    if let Some(storefront_org) = state.config.storefront_org {
        support_state = support_state.with_storefront_org(storefront_org);
    }
    router.merge(console_support_rest::router(support_state))
}

#[cfg(feature = "messenger")]
pub(super) fn mount_messenger(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_messenger_rest::router(
        console_messenger_rest::MessengerRestState::new(
            super::messenger_store(deps.pool),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "notifications")]
pub(super) fn mount_notifications(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_notifications_rest::router(
        console_notifications_rest::NotificationRestState::new(
            super::notification_store(deps.pool),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "inbox")]
pub(super) fn mount_inbox(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_inbox_rest::router(
        console_inbox_rest::InboxRestState::new(
            console_inbox_adapter_postgres::PgInboxStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        )
        .with_passkey_step_up(deps.state.policy_step_up.clone()),
    ))
}

#[cfg(feature = "todos")]
pub(super) fn mount_todos(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_todos_rest::router(
        console_todos_rest::TodoRestState::new(
            console_todos_adapter_postgres::PgTodoStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Webmail (`/api/v1/mail/*`). With the feature on, the router ALWAYS mounts
/// and the app boots without the master key; when `state.mail_cipher` is
/// `None`, read paths degrade cleanly while credential-using endpoints return
/// 503. The inbound-attachment object store (presigned GET) is wired from the
/// same storage config the evidence pipeline uses; `None` when storage is
/// unconfigured (download then 503s). mox integration (slice 1): when
/// `CONSOLE_MAIL_MOX_BASE_URL` is set, the outbound transport rides our own mox
/// server's webapi instead of the lettre SMTP client;
/// `CONSOLE_MAIL_MOX_WEBHOOK_SECRET` arms the inbound delivery webhook (absent
/// → webhook 503s, never hardcoded).
#[cfg(feature = "mail")]
pub(super) fn mount_mail(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    router.merge(console_comms_rest::router(
        console_comms_rest::CommsRestState::new(
            console_comms_adapter_postgres::PgMailStore::new(deps.pool.clone()),
            state.mail_cipher.clone(),
            state.jwt_verifier.clone(),
        )
        .with_attachments(crate::wiring::mail::mail_attachment_store(state))
        .with_mox_transport(state.config.mail_mox_base_url.clone())
        .with_mox_webhook_secret(state.config.mail_mox_webhook_secret.clone()),
    ))
}

/// Notice board (사내 게시판): publish snapshots recipients into
/// `notice_receipts` and fans out one notification per recipient through the
/// SAME notification-center sink the messenger @-mention path uses (#198).
#[cfg(feature = "notices")]
pub(super) fn mount_notices(router: Router, deps: &TenantDeps<'_>) -> Router {
    let pool = deps.pool;
    router.merge(console_notices_rest::router(
        console_notices_rest::NoticeRestState::new(
            console_notices_adapter_postgres::PgNoticeStore::new(pool.clone())
                .with_notification_sink(std::sync::Arc::new(super::notification_store(pool))),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}
