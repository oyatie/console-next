// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

// FIX 4: a worker crash after the provider send but before the SENT mark must
// not cause a second logical delivery. The claimed-but-unmarked alert stays
// SENDING under a lease; only after the lease expires is it reclaimed, and the
// stable idempotency key lets the provider dedupe the (at most one) retry.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn crash_after_send_yields_exactly_one_sent_row_and_stable_idempotency_key(pool: PgPool) {
    use console_dispatch_adapter_postgres::ALERT_LEASE_TTL;

    console_platform_request_context::scope_org(console_kernel_core::OrgId::one(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);
        let timers = DispatchTimerConfig::default();
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
                timers,
            )
            .await
            .unwrap();

        // Materialize the PENDING ALIMTALK_NO_ACK alerts (normally done by the
        // worker's no-ack handler before fanout).
        let no_ack_at =
            time::OffsetDateTime::now_utc() - ALERT_LEASE_TTL - time::Duration::seconds(1);
        store
            .mark_alimtalk_no_ack(console_dispatch_application::ExpireP1DispatchCommand {
                dispatch_id: started.id,
                trace: TraceContext::generate(),
                occurred_at: no_ack_at,
            })
            .await
            .unwrap();

        // --- First worker run: claim + "send", then CRASH before marking SENT. ---
        let notifier = Arc::new(RecordingNotifier::default());
        let claimed = store
            .claim_alimtalk_no_ack_alerts(started.id, no_ack_at)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 2, "two technicians have phones");
        let first_keys: Vec<String> = claimed.iter().map(|a| a.idempotency_key.clone()).collect();
        for alert in &claimed {
            // simulate the provider call succeeding...
            let _ = notifier
                .send_alimtalk(AlimtalkMessage {
                    to: alert.phone.clone(),
                    variables: std::collections::BTreeMap::new(),
                    idempotency_key: alert.idempotency_key.clone(),
                })
                .await;
            // ...then the worker crashes here, before mark_alert_sent.
        }
        // Alerts remain SENDING (leased), none SENT yet.
        assert_eq!(
            alert_count_without_sent_at(&pool, started.id, "ALIMTALK_NO_ACK", "SENDING").await,
            2
        );
        assert_eq!(
            alert_count(&pool, started.id, "ALIMTALK_NO_ACK", "SENT").await,
            0
        );

        // A retry BEFORE the lease expires claims nothing (no double-send window).
        let blocked = store
            .claim_alimtalk_no_ack_alerts(started.id, no_ack_at + time::Duration::seconds(1))
            .await
            .unwrap();
        assert!(blocked.is_empty(), "leased alerts must not be re-claimable");

        // --- Recovery worker run AFTER the lease expires: reclaim + deliver. ---
        let worker = DispatchWorker::new(
            store.clone(),
            Some(notifier.clone()),
            AlimtalkEscalationPolicy::enabled(),
        );
        // Replay the same timer payload after the crashed worker’s lease has expired.
        worker
            .handle(PlatformJob::DispatchAlimtalkNoAck(DispatchTimerJob {
                dispatch_id: started.id,
                org_id: console_kernel_core::OrgId::one(),
                scheduled_for: no_ack_at,
            }))
            .await
            .unwrap();

        // Exactly one SENT row per recipient (two technicians) — no duplicates.
        assert_eq!(
            alert_count(&pool, started.id, "ALIMTALK_NO_ACK", "SENT").await,
            2
        );
        assert_eq!(
            alert_count_without_sent_at(&pool, started.id, "ALIMTALK_NO_ACK", "SENDING").await,
            0
        );

        // The idempotency key is stable across the crash + retry: the keys observed
        // by the provider on the recovery send equal the keys from the first claim.
        let sent_messages = notifier.alimtalk_messages();
        let recovery_keys: Vec<String> = sent_messages
            .iter()
            .skip(2)
            .map(|m| m.idempotency_key.clone())
            .collect();
        assert_eq!(recovery_keys.len(), 2);
        for key in &recovery_keys {
            assert!(
                first_keys.contains(key),
                "idempotency key must be stable across retries: {key}"
            );
            assert!(key.contains(':'), "key must be dispatch_id:alert_id");
        }
    })
    .await;
}
