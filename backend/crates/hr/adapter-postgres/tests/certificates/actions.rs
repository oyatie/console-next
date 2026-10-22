// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_and_reissue_are_atomic_linked_audited_and_never_reuse_numbers(pool: PgPool) {
    let w = World::new(pool).await;
    w.configure().await;
    let first = w.issue(&Uuid::new_v4().to_string()).await;
    let id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    let key = Uuid::new_v4().to_string();
    let next =
        w.hr.reissue_certificate(w.actor.clone(), id, Some(key.clone()), World::reason())
            .await
            .unwrap();
    assert_eq!(
        w.hr.reissue_certificate(w.actor.clone(), id, Some(key), World::reason())
            .await
            .unwrap(),
        next
    );
    assert_eq!(next["replaces_id"], first["id"]);
    assert_ne!(next["certificate_no"], first["certificate_no"]);
    assert!(
        w.hr.certificate(w.actor.clone(), id)
            .await
            .unwrap()
            .voided_at
            .is_some()
    );
    assert_eq!(
        w.hr.reissue_certificate(
            w.actor.clone(),
            id,
            Some(Uuid::new_v4().to_string()),
            World::reason()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_state_conflict"
    );
    let nid = Uuid::parse_str(next["id"].as_str().unwrap()).unwrap();
    let key = Uuid::new_v4().to_string();
    let voided =
        w.hr.void_certificate(w.actor.clone(), nid, Some(key.clone()), World::reason())
            .await
            .unwrap();
    assert_eq!(
        w.hr.void_certificate(w.actor.clone(), nid, Some(key), World::reason())
            .await
            .unwrap(),
        voided
    );
    assert_eq!(
        w.hr.void_certificate(
            w.actor.clone(),
            nid,
            Some(Uuid::new_v4().to_string()),
            World::reason()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_state_conflict"
    );
    assert_eq!(w.count().await, 2);
    let actions:Vec<String>=sqlx::query_scalar("SELECT action FROM audit_events WHERE org_id=$1 AND action LIKE 'certificate.%' ORDER BY action").bind(w.actor.org_id.as_uuid()).fetch_all(&w.owner).await.unwrap();
    for action in [
        "certificate.issue",
        "certificate.reissue",
        "certificate.void",
    ] {
        assert_eq!(
            actions.iter().filter(|a| *a == action).count(),
            1,
            "{action}: {actions:?}"
        );
    }
}
