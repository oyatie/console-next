// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The registration preview resolves the tenant calendar, then its legal-entity override.
mod common;
use common::*;
use console_entity_application::WorkplaceRevision;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn linked_names_follow_the_tenant_and_entity_time_zone(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-calendar").await;
    let (entity, [(workplace, _), _]) = two_workplaces(&store, &actor).await;
    let registration = store
        .get_entity(&actor, entity, true)
        .await
        .unwrap()
        .registrations[0]
        .id;
    let east: String =
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text")
            .fetch_one(&owner)
            .await
            .unwrap();
    let mut input = workplace_from(registration, "동쪽 날짜의 본사").input;
    input.status = Some("CONTINUING".into());
    input.name = Some("동쪽 날짜의 본사".into());
    store
        .revise_workplace(
            &cmd(&actor),
            workplace,
            WorkplaceRevision {
                expected_version: Some(1),
                effective_from: Some(east),
                reason_code: Some("CORRECTION".into()),
                input,
            },
            port(),
        )
        .await
        .unwrap();
    for (scope, zone, expected) in [
        (None, "Pacific/Honolulu", "본사"),
        (Some(entity), "Pacific/Kiritimati", "동쪽 날짜의 본사"),
    ] {
        // rls-arming: ok owner fixture declares the tenant and legal-entity setting.
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id, key, scope_entity_id, value, set_by, reason_code) VALUES ($1, 'calendar.time_zone', $2, to_jsonb($3::text), $4, 'POLICY_REVIEW')")
            .bind(actor.org.as_uuid()).bind(scope).bind(zone).bind(actor.user.as_uuid())
            .execute(&owner).await.unwrap();
        let preview = store
            .registration_end_options(&actor, registration)
            .await
            .unwrap();
        assert_eq!(
            preview
                .linked_workplaces
                .iter()
                .find(|w| w.id == workplace)
                .unwrap()
                .name,
            expected
        );
    }
}
