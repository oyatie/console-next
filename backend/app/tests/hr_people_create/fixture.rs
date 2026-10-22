// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) fn app_state(
    runtime_pool: PgPool,
    leave_command_pool: PgPool,
    keys: &Keys,
) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.public_pem.clone()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.private_pem.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".into()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".into(),
        ),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime_pool))
        .map(|state| state.with_leave_command_database(leave_command_pool))
}
