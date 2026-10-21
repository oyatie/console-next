//! Database URL identity checks run at configuration time.

use crate::config::role::AppRole;
use crate::error::AppError;
use url::Url;

/// The role-dependent presence, distinctness and login-identity checks on the four
/// database URLs, applied in the order `AppConfig::from_pairs` always applied them.
pub(crate) fn validate_database_urls(
    role: AppRole,
    database_url: Option<&str>,
    leave_command_database_url: Option<&str>,
    ontology_command_database_url: Option<&str>,
    platform_force_command_database_url: Option<&str>,
) -> Result<(), AppError> {
    if role == AppRole::Api && database_url.is_some() && leave_command_database_url.is_none() {
        return Err(AppError::Config(
            "LEAVE_COMMAND_DATABASE_URL is required for api role when DATABASE_URL is configured"
                .to_owned(),
        ));
    }
    if role == AppRole::Api && database_url.is_some() && ontology_command_database_url.is_none() {
        return Err(AppError::Config(
            "ONTOLOGY_COMMAND_DATABASE_URL is required for api role when DATABASE_URL is configured"
                .to_owned(),
        ));
    }
    if role == AppRole::Api {
        if database_url.is_some() && platform_force_command_database_url.is_none() {
            return Err(AppError::Config(
                "PLATFORM_FORCE_COMMAND_DATABASE_URL is required for api role when DATABASE_URL is configured".to_owned(),
            ));
        }
        ensure_distinct_database_urls([
            ("DATABASE_URL", database_url),
            ("LEAVE_COMMAND_DATABASE_URL", leave_command_database_url),
            (
                "ONTOLOGY_COMMAND_DATABASE_URL",
                ontology_command_database_url,
            ),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                platform_force_command_database_url,
            ),
        ])?;

        if let (Some(database_url), Some(leave_url), Some(ontology_url), Some(force_url)) = (
            database_url,
            leave_command_database_url,
            ontology_command_database_url,
            platform_force_command_database_url,
        ) {
            let runtime_password =
                validate_database_url_identity("DATABASE_URL", database_url, "console_rt")?;
            let leave_password = validate_database_url_identity(
                "LEAVE_COMMAND_DATABASE_URL",
                leave_url,
                "console_leave_cmd",
            )?;
            let ontology_password = validate_database_url_identity(
                "ONTOLOGY_COMMAND_DATABASE_URL",
                ontology_url,
                "console_ontology_cmd",
            )?;
            let platform_force_password = validate_database_url_identity(
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                force_url,
                "console_platform_force_cmd",
            )?;
            ensure_distinct_database_credentials([
                ("DATABASE_URL", Some(runtime_password.as_str())),
                ("LEAVE_COMMAND_DATABASE_URL", Some(leave_password.as_str())),
                (
                    "ONTOLOGY_COMMAND_DATABASE_URL",
                    Some(ontology_password.as_str()),
                ),
                (
                    "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                    Some(platform_force_password.as_str()),
                ),
            ])?;
        }
    } else {
        let database_password = database_url
            .map(|database_url| {
                let expected_role = match role {
                    AppRole::Worker | AppRole::SchemaCheck => "console_rt",
                    AppRole::Migrate => "console_app",
                    AppRole::Api => unreachable!("api database URLs are validated above"),
                };
                validate_database_url_identity("DATABASE_URL", database_url, expected_role)
            })
            .transpose()?;
        let leave_password = leave_command_database_url
            .map(|url| {
                validate_database_url_identity(
                    "LEAVE_COMMAND_DATABASE_URL",
                    url,
                    "console_leave_cmd",
                )
            })
            .transpose()?;
        let ontology_password = ontology_command_database_url
            .map(|url| {
                validate_database_url_identity(
                    "ONTOLOGY_COMMAND_DATABASE_URL",
                    url,
                    "console_ontology_cmd",
                )
            })
            .transpose()?;
        let platform_force_password = platform_force_command_database_url
            .map(|url| {
                validate_database_url_identity(
                    "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                    url,
                    "console_platform_force_cmd",
                )
            })
            .transpose()?;
        ensure_distinct_database_credentials([
            ("DATABASE_URL", database_password.as_deref()),
            ("LEAVE_COMMAND_DATABASE_URL", leave_password.as_deref()),
            (
                "ONTOLOGY_COMMAND_DATABASE_URL",
                ontology_password.as_deref(),
            ),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                platform_force_password.as_deref(),
            ),
        ])?;
    }
    Ok(())
}

pub(crate) fn validate_database_url_identity(
    env_name: &str,
    raw_url: &str,
    expected_role: &str,
) -> Result<String, AppError> {
    let parsed = Url::parse(raw_url)
        .map_err(|_| AppError::Config(format!("{env_name} must be a valid PostgreSQL URL")))?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql") {
        return Err(AppError::Config(format!(
            "{env_name} must use the postgres or postgresql URL scheme"
        )));
    }

    let username = decode_database_url_component(env_name, "username", parsed.username())?;
    let mut password = parsed
        .password()
        .map(|value| decode_database_url_component(env_name, "password", value))
        .transpose()?;

    for (key, value) in parsed.query_pairs() {
        if key == "user" {
            return Err(AppError::Config(format!(
                "{env_name} must not set PostgreSQL role through DSN options; name the login in the URL authority"
            )));
        } else if key == "password" {
            password = Some(value.into_owned());
        } else if (key == "options" && postgres_options_set_role(&value))
            || key
                .strip_prefix("options[")
                .and_then(|key| key.strip_suffix(']'))
                .is_some_and(|key| key.eq_ignore_ascii_case("role"))
        {
            return Err(AppError::Config(format!(
                "{env_name} must not set PostgreSQL role through DSN options"
            )));
        }
    }

    if username != expected_role {
        return Err(AppError::Config(format!(
            "{env_name} must name PostgreSQL login role {expected_role:?} directly"
        )));
    }
    password
        .filter(|password| !password.is_empty())
        .ok_or_else(|| {
            AppError::Config(format!(
                "{env_name} must contain a nonempty password credential"
            ))
        })
}

fn decode_database_url_component(
    env_name: &str,
    component_name: &str,
    value: &str,
) -> Result<String, AppError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some(high) = bytes.get(index + 1).and_then(|value| hex_digit(*value)) else {
                return Err(AppError::Config(format!(
                    "{env_name} contains an invalid percent-encoded {component_name}"
                )));
            };
            let Some(low) = bytes.get(index + 2).and_then(|value| hex_digit(*value)) else {
                return Err(AppError::Config(format!(
                    "{env_name} contains an invalid percent-encoded {component_name}"
                )));
            };
            decoded.push((high << 4) | low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).map_err(|_| {
        AppError::Config(format!(
            "{env_name} contains a non-UTF-8 percent-encoded {component_name}"
        ))
    })
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn postgres_options_set_role(options: &str) -> bool {
    options.split_ascii_whitespace().any(|token| {
        let token = token.trim_start_matches(['-', '\\']);
        let assignment = token
            .strip_prefix('c')
            .filter(|assignment| assignment.contains('='))
            .unwrap_or(token);
        assignment
            .split_once('=')
            .is_some_and(|(name, _)| name.eq_ignore_ascii_case("role"))
    })
}

pub(crate) fn ensure_distinct_database_urls<const N: usize>(
    urls: [(&str, Option<&str>); N],
) -> Result<(), AppError> {
    for (index, (name, url)) in urls.iter().enumerate() {
        let Some(url) = url else {
            continue;
        };
        for (earlier_name, earlier_url) in &urls[..index] {
            if earlier_url.is_some_and(|earlier_url| earlier_url == *url) {
                return Err(AppError::Config(format!(
                    "{name} must be distinct from {earlier_name}"
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn ensure_distinct_database_credentials<const N: usize>(
    credentials: [(&str, Option<&str>); N],
) -> Result<(), AppError> {
    for (index, (left_name, left_password)) in credentials.iter().enumerate() {
        let Some(left_password) = left_password else {
            continue;
        };
        for (right_name, right_password) in &credentials[index + 1..] {
            if right_password.is_some_and(|right_password| right_password == *left_password) {
                return Err(AppError::Config(format!(
                    "{left_name} and {right_name} must use distinct password credentials"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used)]
mod command_database_config_tests {
    use super::{postgres_options_set_role, validate_database_url_identity};
    use crate::config::AppConfig;
    use crate::config::role::AppRole;
    use crate::state::db::RoleAttributes;
    use crate::state::db::RoleMembership;
    use crate::state::db::SubordinateRoleContract;
    use crate::state::db::ensure_expected_migration_database_identity;
    use crate::state::db::serving::ensure_expected_serving_database_identity;
    use crate::state::db::serving::ensure_expected_serving_database_timeouts;
    use crate::state::db::serving::serving_database_identity_query;

    const RUNTIME_URL: &str = "postgresql://console_rt:runtime-secret@db/console";
    const LEAVE_COMMAND_URL: &str = "postgresql://console_leave_cmd:leave-secret@db/console";
    const ONTOLOGY_COMMAND_URL: &str =
        "postgresql://console_ontology_cmd:ontology-secret@db/console";
    const PLATFORM_FORCE_COMMAND_URL: &str =
        "postgresql://console_platform_force_cmd:platform-force-secret@db/console";

    fn migration_memberships() -> Vec<RoleMembership> {
        ["console_leave_definer", "console_ontology_writer"]
            .into_iter()
            .map(|role_name| RoleMembership {
                role_name: role_name.to_owned(),
                admin_option: false,
                inherit_option: true,
                set_option: true,
            })
            .collect()
    }

    fn migration_subordinate_roles() -> Vec<SubordinateRoleContract> {
        ["console_leave_definer", "console_ontology_writer"]
            .into_iter()
            .map(|role_name| SubordinateRoleContract {
                role_name: role_name.to_owned(),
                attributes: RoleAttributes::HARDENED_DEFINER,
                has_unexpected_membership: false,
            })
            .collect()
    }

    #[test]
    fn api_with_database_requires_distinct_leave_command_database_url() {
        let error =
            AppConfig::from_pairs([("CONSOLE_APP_ROLE", "api"), ("DATABASE_URL", RUNTIME_URL)])
                .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("LEAVE_COMMAND_DATABASE_URL is required for api role"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn blank_leave_command_database_url_fails_closed_for_database_backed_api() {
        assert!(
            AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "api"),
                ("DATABASE_URL", RUNTIME_URL),
                ("LEAVE_COMMAND_DATABASE_URL", "   "),
            ])
            .is_err()
        );
    }

    #[test]
    fn api_accepts_distinct_leave_command_database_url() {
        let config = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
            ("ONTOLOGY_COMMAND_DATABASE_URL", ONTOLOGY_COMMAND_URL),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                PLATFORM_FORCE_COMMAND_URL,
            ),
        ])
        .unwrap();

        assert_eq!(config.role, AppRole::Api);
        assert_eq!(
            config.leave_command_database_url.as_deref(),
            Some(LEAVE_COMMAND_URL)
        );
        assert_eq!(
            config.ontology_command_database_url.as_deref(),
            Some(ONTOLOGY_COMMAND_URL)
        );
        assert_eq!(
            config.platform_force_command_database_url.as_deref(),
            Some(PLATFORM_FORCE_COMMAND_URL)
        );
    }

    #[test]
    fn api_with_database_requires_distinct_ontology_command_database_url() {
        let error = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
        ])
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("ONTOLOGY_COMMAND_DATABASE_URL is required for api role"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn api_with_database_requires_platform_force_command_database_url() {
        let error = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
            ("ONTOLOGY_COMMAND_DATABASE_URL", ONTOLOGY_COMMAND_URL),
        ])
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PLATFORM_FORCE_COMMAND_DATABASE_URL is required for api role")
        );
    }

    #[test]
    fn api_rejects_command_urls_equal_to_runtime_or_each_other() {
        let leave_equals_runtime = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", RUNTIME_URL),
            ("ONTOLOGY_COMMAND_DATABASE_URL", ONTOLOGY_COMMAND_URL),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                PLATFORM_FORCE_COMMAND_URL,
            ),
        ])
        .unwrap_err();
        assert!(
            leave_equals_runtime
                .to_string()
                .contains("LEAVE_COMMAND_DATABASE_URL must be distinct from DATABASE_URL")
        );

        let ontology_equals_runtime = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
            ("ONTOLOGY_COMMAND_DATABASE_URL", RUNTIME_URL),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                PLATFORM_FORCE_COMMAND_URL,
            ),
        ])
        .unwrap_err();
        assert!(
            ontology_equals_runtime
                .to_string()
                .contains("ONTOLOGY_COMMAND_DATABASE_URL must be distinct from DATABASE_URL")
        );

        let shared_command_url = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api"),
            ("DATABASE_URL", RUNTIME_URL),
            ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
            ("ONTOLOGY_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
            (
                "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                PLATFORM_FORCE_COMMAND_URL,
            ),
        ])
        .unwrap_err();
        assert!(shared_command_url.to_string().contains(
            "ONTOLOGY_COMMAND_DATABASE_URL must be distinct from LEAVE_COMMAND_DATABASE_URL"
        ));

        for (conflicting_url, expected) in [
            (RUNTIME_URL, "DATABASE_URL"),
            (LEAVE_COMMAND_URL, "LEAVE_COMMAND_DATABASE_URL"),
            (ONTOLOGY_COMMAND_URL, "ONTOLOGY_COMMAND_DATABASE_URL"),
        ] {
            let error = AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "api"),
                ("DATABASE_URL", RUNTIME_URL),
                ("LEAVE_COMMAND_DATABASE_URL", LEAVE_COMMAND_URL),
                ("ONTOLOGY_COMMAND_DATABASE_URL", ONTOLOGY_COMMAND_URL),
                ("PLATFORM_FORCE_COMMAND_DATABASE_URL", conflicting_url),
            ])
            .unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "platform-force URL collision with {expected} must be rejected: {error}"
            );
        }
    }

    #[test]
    fn connected_role_guards_require_exact_direct_identity_without_membership() {
        assert!(
            ensure_expected_serving_database_identity(
                "LEAVE_COMMAND_DATABASE_URL",
                "console_leave_cmd",
                "console_leave_cmd",
                "console_leave_cmd",
                RoleAttributes::HARDENED_LOGIN,
                false,
            )
            .is_ok()
        );
        assert!(
            ensure_expected_serving_database_identity(
                "DATABASE_URL",
                "console_rt",
                "console_leave_cmd",
                "console_rt",
                RoleAttributes::HARDENED_LOGIN,
                false,
            )
            .is_err()
        );
        assert!(
            ensure_expected_serving_database_identity(
                "DATABASE_URL",
                "local_dev",
                "console_rt",
                "console_rt",
                RoleAttributes::HARDENED_LOGIN,
                false,
            )
            .is_err()
        );
        assert!(
            ensure_expected_serving_database_identity(
                "DATABASE_URL",
                "console_rt",
                "console_rt",
                "console_rt",
                RoleAttributes::HARDENED_LOGIN,
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn serving_role_guards_reject_each_escalating_attribute() {
        let hostile_attributes = [
            RoleAttributes {
                can_login: false,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                is_superuser: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                bypasses_rls: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                inherits_privileges: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                can_create_db: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                can_create_role: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
            RoleAttributes {
                can_replicate: true,
                ..RoleAttributes::HARDENED_LOGIN
            },
        ];

        for attributes in hostile_attributes {
            assert!(
                ensure_expected_serving_database_identity(
                    "DATABASE_URL",
                    "console_rt",
                    "console_rt",
                    "console_rt",
                    attributes,
                    false,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn database_urls_reject_login_role_aliases_and_role_options() {
        assert!(
            validate_database_url_identity(
                "DATABASE_URL",
                "postgresql://local_dev:secret@db/console",
                "console_rt",
            )
            .is_err()
        );

        for options in [
            "-c role=console_rt",
            "-crole=console_rt",
            "--ROLE=console_rt",
            "role=console_rt",
        ] {
            assert!(postgres_options_set_role(options), "options: {options}");
        }
        assert!(!postgres_options_set_role("-c search_path=public"));

        for url in [
            "postgresql://console_rt:secret@db/console?options=-c%20role%3Dconsole_rt",
            "postgresql://console_rt:secret@db/console?options=-crole%3Dconsole_rt",
            "postgresql://console_rt:secret@db/console?options%5Brole%5D=console_rt",
            "postgresql://local_dev:secret@db/console?user=console_rt",
        ] {
            let error =
                validate_database_url_identity("DATABASE_URL", url, "console_rt").unwrap_err();
            assert!(
                error.to_string().contains("must not set PostgreSQL role"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn database_urls_require_nonempty_decoded_passwords() {
        for url in [
            "postgresql://console_rt@db/console",
            "postgresql://console_rt:@db/console",
            "postgresql://console_rt:secret@db/console?password=",
        ] {
            let error =
                validate_database_url_identity("DATABASE_URL", url, "console_rt").unwrap_err();
            let message = error.to_string();
            assert!(
                message.contains("nonempty password"),
                "unexpected error: {message}"
            );
            assert!(!message.contains("secret"));
        }
    }

    #[test]
    fn serving_identity_query_checks_all_memberships_and_role_attributes() {
        let query = serving_database_identity_query();
        assert!(query.contains("pg_has_role"));
        assert!(query.contains("'MEMBER'"));
        assert!(query.contains("pg_auth_members"));
        assert!(query.contains("membership.roleid = authenticated.oid"));
        for attribute in [
            "rolcanlogin",
            "rolsuper",
            "rolbypassrls",
            "rolinherit",
            "rolcreatedb",
            "rolcreaterole",
            "rolreplication",
        ] {
            assert!(query.contains(attribute));
        }
        for timeout in [
            "statement_timeout",
            "idle_in_transaction_session_timeout",
            "transaction_timeout",
        ] {
            assert!(query.contains(timeout));
        }
    }

    #[test]
    fn serving_timeout_guards_accept_only_exact_effective_defaults() {
        assert!(
            ensure_expected_serving_database_timeouts(
                "DATABASE_URL",
                "30s",
                "30s",
                "45s",
                true,
                true,
                true,
            )
            .is_ok()
        );

        for matches in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
            (false, false, false),
        ] {
            let error = ensure_expected_serving_database_timeouts(
                "DATABASE_URL",
                "29s",
                "31s",
                "44s",
                matches.0,
                matches.1,
                matches.2,
            )
            .unwrap_err();
            let message = error.to_string();

            assert!(message.contains("statement_timeout=\"29s\""));
            assert!(message.contains("idle_in_transaction_session_timeout=\"31s\""));
            assert!(message.contains("transaction_timeout=\"44s\""));
            assert!(message.contains("required statement_timeout=30s"));
            assert!(message.contains("idle_in_transaction_session_timeout=30s"));
            assert!(message.contains("transaction_timeout=45s"));
        }
    }

    #[test]
    fn migration_identity_accepts_only_the_exact_owner_topology() {
        assert!(
            ensure_expected_migration_database_identity(
                "console_app",
                "console_app",
                "console_app",
                RoleAttributes::HARDENED_MIGRATION_LOGIN,
                &migration_memberships(),
                &migration_subordinate_roles(),
                false,
            )
            .is_ok()
        );

        for (session_user, current_user, owner) in [
            ("bootstrap", "console_app", "console_app"),
            ("console_app", "console_leave_definer", "console_app"),
            ("console_app", "console_app", "bootstrap"),
        ] {
            assert!(
                ensure_expected_migration_database_identity(
                    session_user,
                    current_user,
                    owner,
                    RoleAttributes::HARDENED_MIGRATION_LOGIN,
                    &migration_memberships(),
                    &migration_subordinate_roles(),
                    false,
                )
                .is_err()
            );
        }

        let hostile_attributes = [
            RoleAttributes {
                can_login: false,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                is_superuser: true,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                bypasses_rls: false,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                inherits_privileges: false,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                can_create_db: true,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                can_create_role: true,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
            RoleAttributes {
                can_replicate: true,
                ..RoleAttributes::HARDENED_MIGRATION_LOGIN
            },
        ];
        for attributes in hostile_attributes {
            assert!(
                ensure_expected_migration_database_identity(
                    "console_app",
                    "console_app",
                    "console_app",
                    attributes,
                    &migration_memberships(),
                    &migration_subordinate_roles(),
                    false,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn migration_identity_rejects_membership_and_definer_drift() {
        let mut missing_membership = migration_memberships();
        missing_membership.pop();
        let mut admin_membership = migration_memberships();
        admin_membership[0].admin_option = true;
        let mut non_inheritable_membership = migration_memberships();
        non_inheritable_membership[0].inherit_option = false;
        let mut non_settable_membership = migration_memberships();
        non_settable_membership[1].set_option = false;
        let mut extra_membership = migration_memberships();
        extra_membership.push(RoleMembership {
            role_name: "pg_read_all_data".to_owned(),
            admin_option: false,
            inherit_option: true,
            set_option: true,
        });
        for memberships in [
            missing_membership,
            admin_membership,
            non_inheritable_membership,
            non_settable_membership,
            extra_membership,
        ] {
            assert!(
                ensure_expected_migration_database_identity(
                    "console_app",
                    "console_app",
                    "console_app",
                    RoleAttributes::HARDENED_MIGRATION_LOGIN,
                    &memberships,
                    &migration_subordinate_roles(),
                    false,
                )
                .is_err()
            );
        }

        let mut login_definer = migration_subordinate_roles();
        login_definer[0].attributes.can_login = true;
        let mut inheriting_definer = migration_subordinate_roles();
        inheriting_definer[0].attributes.inherits_privileges = true;
        let mut privileged_definer = migration_subordinate_roles();
        privileged_definer[1].attributes.bypasses_rls = true;
        let mut member_definer = migration_subordinate_roles();
        member_definer[1].has_unexpected_membership = true;
        for subordinate_roles in [
            login_definer,
            inheriting_definer,
            privileged_definer,
            member_definer,
        ] {
            assert!(
                ensure_expected_migration_database_identity(
                    "console_app",
                    "console_app",
                    "console_app",
                    RoleAttributes::HARDENED_MIGRATION_LOGIN,
                    &migration_memberships(),
                    &subordinate_roles,
                    false,
                )
                .is_err()
            );
        }

        assert!(
            ensure_expected_migration_database_identity(
                "console_app",
                "console_app",
                "console_app",
                RoleAttributes::HARDENED_MIGRATION_LOGIN,
                &migration_memberships(),
                &migration_subordinate_roles(),
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn migration_identity_rejects_incoming_console_app_membership_edge() {
        let error = ensure_expected_migration_database_identity(
            "console_app",
            "console_app",
            "console_app",
            RoleAttributes::HARDENED_MIGRATION_LOGIN,
            &migration_memberships(),
            &migration_subordinate_roles(),
            true,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("forbidden membership edge"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn serving_identity_rejects_outgoing_or_incoming_membership_edges() {
        let error = ensure_expected_serving_database_identity(
            "DATABASE_URL",
            "console_rt",
            "console_rt",
            "console_rt",
            RoleAttributes::HARDENED_LOGIN,
            true,
        )
        .unwrap_err();
        assert!(error.to_string().contains("membership edge"));
    }

    #[test]
    fn api_rejects_pairwise_equal_decoded_database_passwords() {
        let cases = [
            (
                "postgresql://console_rt:shared%2Dsecret@db/console",
                "postgresql://console_leave_cmd:shared-secret@db/leave",
                ONTOLOGY_COMMAND_URL,
                PLATFORM_FORCE_COMMAND_URL,
                "DATABASE_URL and LEAVE_COMMAND_DATABASE_URL",
            ),
            (
                RUNTIME_URL,
                "postgresql://console_leave_cmd:shared%2Dsecret@db/leave",
                "postgresql://console_ontology_cmd:shared-secret@db/ontology",
                PLATFORM_FORCE_COMMAND_URL,
                "LEAVE_COMMAND_DATABASE_URL and ONTOLOGY_COMMAND_DATABASE_URL",
            ),
            (
                "postgresql://console_rt:query-secret@db/runtime",
                LEAVE_COMMAND_URL,
                "postgresql://console_ontology_cmd:different@db/ontology?password=query-secret",
                PLATFORM_FORCE_COMMAND_URL,
                "DATABASE_URL and ONTOLOGY_COMMAND_DATABASE_URL",
            ),
            (
                "postgresql://console_rt:force-secret@db/runtime",
                LEAVE_COMMAND_URL,
                ONTOLOGY_COMMAND_URL,
                "postgresql://console_platform_force_cmd:force-secret@db/platform-force",
                "DATABASE_URL and PLATFORM_FORCE_COMMAND_DATABASE_URL",
            ),
            (
                RUNTIME_URL,
                "postgresql://console_leave_cmd:force-secret@db/leave",
                ONTOLOGY_COMMAND_URL,
                "postgresql://console_platform_force_cmd:force-secret@db/platform-force",
                "LEAVE_COMMAND_DATABASE_URL and PLATFORM_FORCE_COMMAND_DATABASE_URL",
            ),
            (
                RUNTIME_URL,
                LEAVE_COMMAND_URL,
                "postgresql://console_ontology_cmd:force-secret@db/ontology",
                "postgresql://console_platform_force_cmd:force-secret@db/platform-force",
                "ONTOLOGY_COMMAND_DATABASE_URL and PLATFORM_FORCE_COMMAND_DATABASE_URL",
            ),
        ];

        for (runtime, leave, ontology, platform_force, expected_pair) in cases {
            let error = AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "api"),
                ("DATABASE_URL", runtime),
                ("LEAVE_COMMAND_DATABASE_URL", leave),
                ("ONTOLOGY_COMMAND_DATABASE_URL", ontology),
                ("PLATFORM_FORCE_COMMAND_DATABASE_URL", platform_force),
            ])
            .unwrap_err();
            let message = error.to_string();
            assert!(
                message.contains(expected_pair),
                "unexpected error: {message}"
            );
            assert!(!message.contains("shared-secret"));
            assert!(!message.contains("query-secret"));
            assert!(!message.contains("force-secret"));
        }
    }

    #[test]
    fn database_free_api_does_not_require_leave_command_database_url() {
        let config = AppConfig::from_pairs([("CONSOLE_APP_ROLE", "api")]).unwrap();

        assert!(config.database_url.is_none());
        assert!(config.leave_command_database_url.is_none());
        assert!(config.ontology_command_database_url.is_none());
    }

    #[test]
    fn worker_and_migrate_do_not_require_leave_command_database_url() {
        for (role, database_url) in [
            ("worker", RUNTIME_URL),
            (
                "migrate",
                "postgresql://console_app:migration-secret@db/console",
            ),
        ] {
            let config =
                AppConfig::from_pairs([("CONSOLE_APP_ROLE", role), ("DATABASE_URL", database_url)])
                    .unwrap();

            assert!(config.leave_command_database_url.is_none());
            assert!(config.ontology_command_database_url.is_none());
        }
    }

    #[test]
    fn worker_requires_exact_runtime_login_but_migrate_keeps_owner_url() {
        assert!(
            AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "worker"),
                ("DATABASE_URL", "postgresql://local_dev:secret@db/console",),
            ])
            .is_err()
        );
        assert!(
            AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "migrate"),
                ("DATABASE_URL", "postgresql://console_app:secret@db/console",),
            ])
            .is_ok()
        );
        assert!(
            AppConfig::from_pairs([
                ("CONSOLE_APP_ROLE", "migrate"),
                ("DATABASE_URL", "postgresql://console_rt:secret@db/console",),
            ])
            .is_err()
        );
    }
}
