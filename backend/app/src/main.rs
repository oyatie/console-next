use console_app::{
    AppConfig, AppRole, AppState, init_tracing, run_migrations, run_schema_check, serve,
};

#[tokio::main]
async fn main() -> Result<(), console_app::AppError> {
    // PR-10: the compose healthcheck (no curl in the image); needs no config.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(console_app::healthcheck());
    }
    // BG-3 contract: an unknown role exits 64 (EX_USAGE), so the rollback
    // rehearsal can tell "this release predates the role" from "incompatible".
    if let Ok(role) = std::env::var("CONSOLE_APP_ROLE")
        && role.parse::<AppRole>().is_err()
    {
        eprintln!("unknown CONSOLE_APP_ROLE {role:?}");
        std::process::exit(64);
    }
    let config = AppConfig::from_env()?;
    let telemetry = init_tracing(&config)?;

    // Migrate and schema-check are one-shot runs: they need only DATABASE_URL
    // and must NOT build the full AppState (no JWT/S3 wiring, no HTTP server),
    // so a migration Job can run with a minimal environment, then exit.
    let result = match config.role {
        AppRole::Migrate => run_migrations(&config).await,
        AppRole::SchemaCheck => run_schema_check(&config).await,
        AppRole::Api | AppRole::Worker => {
            let state = AppState::from_config(config.clone()).await?;
            serve(config, state).await
        }
    };
    telemetry.shutdown();
    result
}
