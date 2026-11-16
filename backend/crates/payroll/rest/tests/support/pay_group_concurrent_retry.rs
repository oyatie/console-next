// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_replays_concurrent_creates_once(pool: PgPool) {
    const LOCK_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    const CREATE_AND_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    let (service, token, input, org, _, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    // Hold the INSERT until the retry has observed the admitted, unfinished command.
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE pay_groups IN SHARE MODE")
        .execute(&mut *gate)
        .await
        .unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await
        .unwrap();
    let first = keyed(service.clone(), &token, input.clone(), &key);
    let started = std::time::Instant::now();
    let retry = async {
        if tokio::time::timeout(LOCK_WAIT_TIMEOUT, async {
            loop {
                let blocked: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='pay_groups'::regclass AND mode='RowExclusiveLock' AND NOT granted AND $1=ANY(pg_blocking_pids(pid)))",
                )
                .bind(blocker)
                .fetch_one(&pool)
                .await
                .unwrap();
                if blocked {
                    break;
                }
                // Leave the lock manager available to the request being observed.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .is_err()
        {
            let pool_state = (pool.size(), pool.num_idle());
            let activity = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                sqlx::query_scalar::<_, Value>(
                    "SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'blocking_pids',pg_blocking_pids(pid),'state',state,'wait_event_type',wait_event_type,'wait_event',wait_event,'query',query) ORDER BY pid),'[]'::jsonb) FROM pg_stat_activity WHERE datname=current_database()",
                )
                .fetch_one(&mut *gate),
            )
            .await;
            panic!("first pay-group create did not reach the held INSERT lock within {LOCK_WAIT_TIMEOUT:?}; blocker={blocker}; pool (size, idle)={pool_state:?}; pg_stat_activity={activity:?}");
        }
        eprintln!("pay-group lock wait: {:?}", started.elapsed());
        let state: (String, bool) = sqlx::query_as(
            "SELECT state,execution_token IS NOT NULL FROM command_outcomes WHERE org_id=$1 AND idempotency_key=$2",
        )
        .bind(org.as_uuid())
        .bind(&key)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(state, ("PROCESSING".into(), true));
        let retry = keyed(service.clone(), &token, input.clone(), &key).await;
        assert_eq!(retry.status, StatusCode::CONFLICT, "{}", retry.json);
        assert_eq!(retry.json["error"]["code"], "command_processing");
        assert_eq!(counts(&pool, org).await, (0, 1, 0));
        gate.rollback().await.unwrap();
    };
    let (created, ()) = tokio::time::timeout(CREATE_AND_RETRY_TIMEOUT, async {
        tokio::join!(first, retry)
    })
    .await
    .unwrap_or_else(|_| {
        panic!("concurrent create and retry did not settle within {CREATE_AND_RETRY_TIMEOUT:?}")
    });
    eprintln!("pay-group create and retry: {:?}", started.elapsed());
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let replay = keyed(service, &token, input, &key).await;
    assert_eq!(replay.status, StatusCode::CREATED, "{}", replay.json);
    assert_eq!(replay.json["id"], created.json["id"]);
    assert_eq!(replay.json, created.json);
    assert_eq!(counts(&pool, org).await, (1, 1, 1));
}
