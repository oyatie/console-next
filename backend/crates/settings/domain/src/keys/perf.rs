//! PERF-BE keys (decisions #28: "a connection pool sized against Postgres").
//! Each process's database pool, read at start: mirrors of process
//! configuration (`ReadOnly`: shown, never written). A deployment may override
//! one by its `CONSOLE_DB_POOL_*` variable, inside these bounds. The API's
//! runtime pool is its share of Postgres `max_connections` after the reserve and
//! the workers, capped by `db.pool.api_connections`. Append-only; see
//! `keys/mod.rs`.

macro_rules! perf { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Most runtime connections one API process opens (its share may be lower).
    DbPoolApiConnections => "db.pool.api_connections" = D::int(Count, Some(2), Some(48), 16, Neutral).governed(Governance::ReadOnly);
    // Runtime connections one worker process opens.
    DbPoolWorkerConnections => "db.pool.worker_connections" = D::int(Count, Some(2), Some(32), 6, Neutral).governed(Governance::ReadOnly);
    // How long a request waits for a pooled connection before it is shed (503 + Retry-After).
    DbPoolAcquireTimeoutMs => "db.pool.acquire_timeout_ms" = D::int(Milliseconds, Some(100), Some(10_000), 1_000, Neutral).governed(Governance::ReadOnly);
    // API processes that may run at once (a rollout's surge included).
    DbPoolPeakApiProcesses => "db.pool.peak_api_processes" = D::int(Count, Some(1), Some(8), 2, Neutral).governed(Governance::ReadOnly);
    // Worker processes that may run at once (a rollout's surge included).
    DbPoolPeakWorkerProcesses => "db.pool.peak_worker_processes" = D::int(Count, Some(1), Some(8), 2, Neutral).governed(Governance::ReadOnly);
    // Postgres connections kept free for migration, topology and operators.
    DbPoolReservedConnections => "db.pool.reserved_connections" = D::int(Count, Some(0), Some(32), 8, Neutral).governed(Governance::ReadOnly);
    // Shared source reads across every inbox request in an API process.
    ActionInboxSourceConcurrency => "action_inbox.source_concurrency" = D::int(Count, Some(1), Some(8), 4, Neutral).governed(Governance::ReadOnly);
] $($rest)* } }; }
