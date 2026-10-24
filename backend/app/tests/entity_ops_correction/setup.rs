// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) struct Setup {
    pub service: axum::Router,
    pub issuer: console_platform_auth::JwtIssuer,
    pub svc: console_platform_auth::PasskeyService,
    pub ops: Admin,
    pub approver: Admin,
    pub contributor: Admin,
    pub member: Admin,
    pub entity: Uuid,
    pub doc: Uuid,
}

pub(super) async fn setup(owner: &PgPool) -> Setup {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("g101-{}", &org.simple().to_string()[..12]))
        .execute(owner)
        .await
        .unwrap();
    let (service, issuer) = router(owner).await;
    let svc = passkey_service();
    let tenant = OrgId::from_uuid(org);
    let ops: Admin = admin_in(owner, &svc, &issuer, tenant, "운영 관리자").await;
    let approver: Admin = admin_in(owner, &svc, &issuer, tenant, "결재 관리자").await;
    let contributor: Admin = admin_in(owner, &svc, &issuer, tenant, "작성 관리자").await;
    let mut member: Admin = admin_in(owner, &svc, &issuer, tenant, "일반 사용자").await;
    sqlx::query("UPDATE users SET roles = ARRAY['MEMBER'] WHERE id = $1")
        .bind(member.id)
        .execute(owner)
        .await
        .unwrap();
    member.token =
        period_unlock_support::session_token(owner, &issuer, tenant, member.id, "MEMBER").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(ops.id)
        .execute(owner)
        .await
        .unwrap();

    let (status, _) = send(
        &service,
        "/api/v1/onboarding/terms",
        &ops.token,
        Some(&key()),
        terms::publish(owner).await,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, entity) = send(
        &service,
        "/api/v1/legal-entities",
        &contributor.token,
        Some(&key()),
        json!({
            "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
            "representatives": ["홍길동"], "crn": "130111-0006246",
            "head_office_address": { "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
                                     "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity: Uuid = entity["record"]["id"].as_str().unwrap().parse().unwrap();
    let doc = upload(&service, &ops.token).await;
    armed(
        owner,
        org,
        "UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1",
        org,
    )
    .await;
    armed(
        owner,
        org,
        "UPDATE legal_entities SET identity_locked_at = now() WHERE id = $1",
        entity,
    )
    .await;

    Setup {
        service,
        issuer,
        svc,
        ops,
        approver,
        contributor,
        member,
        entity,
        doc,
    }
}
