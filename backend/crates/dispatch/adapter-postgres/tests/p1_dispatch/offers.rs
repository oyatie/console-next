// SPDX-License-Identifier: LicenseRef-Proprietary
use super::seed_dispatch_context;
use console_dispatch_adapter_postgres::PgDispatchStore;
use console_dispatch_application::{
    IncidentLocationInput, RespondP1DispatchCommand, StartP1DispatchCommand,
};
use console_dispatch_domain::{DispatchResponseKind, DispatchTimerConfig};
use console_kernel_core::TraceContext;
use sqlx::PgPool;
use time::macros::datetime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn my_pending_offers_lists_only_unanswered_targets(pool: PgPool) {
    console_platform_request_context::scope_org(console_kernel_core::OrgId::one(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);

        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id: seeded.work_order_id,
                    incident_location: Some(IncidentLocationInput {
                        latitude: 37.5651,
                        longitude: 126.9895,
                    }),
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();

        // The targeted mechanic sees exactly one pending offer, addressed at
        // the started dispatch, inside the accept window.
        let offers = store
            .list_my_pending_offers(seeded.near_mechanic, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert_eq!(offers.len(), 1, "targeted mechanic sees the offer");
        assert_eq!(offers[0].dispatch_id, started.id);
        assert_eq!(offers[0].work_order_id, seeded.work_order_id);
        assert!(!offers[0].request_no.is_empty());
        assert!(offers[0].site_name.starts_with("Dispatch Site "));
        assert_eq!(offers[0].symptom, "Emergency dispatch test");

        // A user the fan-out never targeted sees nothing (deny-by-omission),
        // and neither does a receptionist.
        let untargeted = store
            .list_my_pending_offers(seeded.off_duty_mechanic, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert!(untargeted.is_empty(), "untargeted user sees no offers");
        let receptionist = store
            .list_my_pending_offers(seeded.receptionist, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert!(receptionist.is_empty());

        // After the mechanic responds, the offer leaves their pending list.
        store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.near_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Decline,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(20),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        let after_response = store
            .list_my_pending_offers(seeded.near_mechanic, now + time::Duration::seconds(25))
            .await
            .unwrap();
        assert!(after_response.is_empty(), "answered offer is gone");

        // Past the accept window the offer disappears for everyone.
        let expired = store
            .list_my_pending_offers(seeded.far_mechanic, started.accept_window_ends_at)
            .await
            .unwrap();
        assert!(expired.is_empty(), "window-expired offer is gone");
    })
    .await;
}
