//! PostgreSQL connection identity: role attribute and membership contracts.

pub(crate) mod migration;
pub(crate) mod runtime_pool;
pub(crate) mod serving;

#[cfg(all(test, feature = "test-postgres"))]
mod release_guard_tests;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RoleAttributes {
    pub(crate) can_login: bool,
    pub(crate) is_superuser: bool,
    pub(crate) bypasses_rls: bool,
    pub(crate) inherits_privileges: bool,
    pub(crate) can_create_db: bool,
    pub(crate) can_create_role: bool,
    pub(crate) can_replicate: bool,
}

impl RoleAttributes {
    pub(crate) const HARDENED_LOGIN: Self = Self {
        can_login: true,
        is_superuser: false,
        bypasses_rls: false,
        inherits_privileges: false,
        can_create_db: false,
        can_create_role: false,
        can_replicate: false,
    };

    pub(crate) const HARDENED_MIGRATION_LOGIN: Self = Self {
        bypasses_rls: true,
        inherits_privileges: true,
        ..Self::HARDENED_LOGIN
    };

    pub(crate) const HARDENED_DEFINER: Self = Self {
        can_login: false,
        ..Self::HARDENED_LOGIN
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoleMembership {
    pub(crate) role_name: String,
    pub(crate) admin_option: bool,
    pub(crate) inherit_option: bool,
    pub(crate) set_option: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubordinateRoleContract {
    pub(crate) role_name: String,
    pub(crate) attributes: RoleAttributes,
    pub(crate) has_unexpected_membership: bool,
}

pub(crate) fn ensure_expected_migration_database_identity(
    session_user: &str,
    current_user: &str,
    database_owner: &str,
    attributes: RoleAttributes,
    memberships: &[RoleMembership],
    subordinate_roles: &[SubordinateRoleContract],
    has_unexpected_application_membership_edge: bool,
) -> Result<(), AppError> {
    if session_user != "console_app" || current_user != "console_app" {
        return Err(AppError::Config(format!(
            "DATABASE_URL migration connection must authenticate directly as PostgreSQL role \
             \"console_app\"; session_user={session_user:?}, current_user={current_user:?}"
        )));
    }
    if database_owner != "console_app" {
        return Err(AppError::Config(
            "DATABASE_URL migration database must be owned by PostgreSQL role \"console_app\""
                .to_owned(),
        ));
    }
    if attributes != RoleAttributes::HARDENED_MIGRATION_LOGIN {
        return Err(AppError::Config(
            "DATABASE_URL migration role \"console_app\" must be LOGIN, INHERIT, NOSUPERUSER, \
             BYPASSRLS, NOCREATEDB, NOCREATEROLE, and NOREPLICATION"
                .to_owned(),
        ));
    }

    const EXPECTED_DEFINERS: [&str; 2] = ["console_leave_definer", "console_ontology_writer"];
    if memberships.len() != EXPECTED_DEFINERS.len()
        || EXPECTED_DEFINERS.iter().any(|expected| {
            !memberships.iter().any(|membership| {
                membership.role_name == *expected
                    && !membership.admin_option
                    && membership.inherit_option
                    && membership.set_option
            })
        })
    {
        return Err(AppError::Config(
            "DATABASE_URL migration role \"console_app\" must have exactly the console_leave_definer and \
             console_ontology_writer memberships with ADMIN false, INHERIT true, and SET true"
                .to_owned(),
        ));
    }
    if has_unexpected_application_membership_edge {
        return Err(AppError::Config(
            "migration application roles have a forbidden membership edge; only console_app membership in the two definer roles is permitted"
                .to_owned(),
        ));
    }
    if subordinate_roles.len() != EXPECTED_DEFINERS.len()
        || EXPECTED_DEFINERS.iter().any(|expected| {
            !subordinate_roles.iter().any(|subordinate| {
                subordinate.role_name == *expected
                    && subordinate.attributes == RoleAttributes::HARDENED_DEFINER
                    && !subordinate.has_unexpected_membership
            })
        })
    {
        return Err(AppError::Config(
            "migration definer roles must both be NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, \
             NOCREATEDB, NOCREATEROLE, NOREPLICATION, and have no role memberships"
                .to_owned(),
        ));
    }
    Ok(())
}
