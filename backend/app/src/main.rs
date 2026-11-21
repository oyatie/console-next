use console_app::{
    AppConfig, AppError, AppRole, AppState, init_tracing, run_migrations, run_ops_cockpit,
    run_schema_check, serve,
};

#[tokio::main]
async fn main() -> Result<(), console_app::AppError> {
    // PR-10: the compose healthcheck (no curl in the image); needs no config.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(console_app::healthcheck());
    }
    if let Some(
        cmd @ ("crypto-reseal" | "crypto-census" | "rotate-tenant-dek" | "rewrap-master-kek"),
    ) = std::env::args().nth(1).as_deref()
    {
        let extra_args: Vec<String> = std::env::args().skip(2).collect();
        if let Err(err) = console_app::run_crypto_cli(cmd, &extra_args).await {
            eprintln!("{cmd} failed: {err}");
            std::process::exit(1);
        }
        return Ok(());
    }
    // BG-3 contract: an unknown role exits 64 (EX_USAGE), so the rollback
    // rehearsal can tell "this release predates the role" from "incompatible".
    if let Ok(role) = std::env::var("CONSOLE_APP_ROLE")
        && role.parse::<AppRole>().is_err()
    {
        eprintln!("unknown CONSOLE_APP_ROLE {role:?}");
        std::process::exit(64);
    }
    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(AppError::OpsConfig(msg)) => {
            eprintln!("{msg}");
            std::process::exit(78);
        }
        Err(err) => return Err(err),
    };
    let telemetry = init_tracing(&config)?;

    // Migrate and schema-check are one-shot runs: they need only DATABASE_URL
    // and must NOT build the full AppState (no JWT/S3 wiring, no HTTP server),
    // so a migration Job can run with a minimal environment, then exit.
    let result = match config.role {
        AppRole::Migrate => run_migrations(&config).await,
        AppRole::SchemaCheck => run_schema_check(&config).await,
        AppRole::Ops => run_ops_cockpit(config).await,
        AppRole::Api | AppRole::Worker => {
            let state = AppState::from_config(config.clone()).await?;
            serve(config, state).await
        }
    };
    telemetry.shutdown();
    match result {
        Err(AppError::OpsConfig(msg)) => {
            eprintln!("{msg}");
            std::process::exit(78);
        }
        other => other,
    }
}
