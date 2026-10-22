// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn check(
    service: &axum::Router,
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    issuer: &console_platform_auth::JwtIssuer,
    requester: &Admin,
    lock_id: Uuid,
    request_id: Uuid,
) {
    let alias = admin(owner, svc, issuer, "다른 계정").await;
    let person: Uuid = sqlx::query_scalar("SELECT b.person_id FROM users u JOIN employee_person_bindings b ON b.org_id=u.org_id AND b.employee_id=u.employee_id WHERE u.id=$1")
        .bind(requester.id).fetch_one(owner).await.unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=(SELECT employee_id FROM users WHERE id=$1)")
        .bind(alias.id).execute(owner).await.unwrap();
    period_unlock_support::person_fixtures::bind_user_to_person(
        owner,
        console_kernel_core::UserId::from_uuid(alias.id),
        person,
    )
    .await;
    let (status, body) = reject(service, &alias.token, lock_id, request_id, "반려").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "second_person_required")
    );

    // Missing or failed identity facts still refuse; an unbound known account is covered separately.
    let resolver: String = sqlx::query_scalar("SELECT pg_get_functiondef('public.console_decision_identities(uuid,uuid,uuid)'::regprocedure)")
        .fetch_one(owner).await.unwrap();
    sqlx::query("CREATE OR REPLACE FUNCTION public.console_decision_identities(p_org UUID,p_maker UUID,p_checker UUID) RETURNS TABLE (maker_identity TEXT,checker_identity TEXT) LANGUAGE sql AS 'SELECT NULL::text,NULL::text'")
        .execute(owner).await.unwrap();
    let missing = admin(owner, svc, issuer, "신원 누락").await;
    let (status, body) = reject(service, &missing.token, lock_id, request_id, "반려").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "second_person_required")
    );
    assert_eq!(
        request_of(service, &missing.token, lock_id).await["canDecide"],
        false
    );
    // Restore only the definition read from pg_catalog, with no external input.
    sqlx::query(sqlx::AssertSqlSafe(resolver))
        .execute(owner)
        .await
        .unwrap();
}
