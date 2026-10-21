use std::str::FromStr;

use console_kernel_core::KernelError;

/// Canonical role codes stored in `users.roles`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum Role {
    #[serde(rename = "SUPER_ADMIN")]
    SuperAdmin,
    #[serde(rename = "ADMIN")]
    Admin,
    #[serde(rename = "MECHANIC")]
    Mechanic,
    #[serde(rename = "RECEPTIONIST")]
    Receptionist,
    #[serde(rename = "EXECUTIVE")]
    Executive,
    /// Lowest-privilege tier. The default role for an open self-service signup
    /// (#38): a freshly self-registered account can sign in but sees almost
    /// nothing until an admin elevates it. Deliberately the bottom of the matrix
    /// (`matrix_index` 0) with `Login` as its only `Allow` cell.
    #[serde(rename = "MEMBER")]
    Member,
}

impl Role {
    pub const ALL: [Self; 6] = [
        Self::Member,
        Self::Receptionist,
        Self::Mechanic,
        Self::Admin,
        Self::Executive,
        Self::SuperAdmin,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SuperAdmin => "SUPER_ADMIN",
            Self::Admin => "ADMIN",
            Self::Mechanic => "MECHANIC",
            Self::Receptionist => "RECEPTIONIST",
            Self::Executive => "EXECUTIVE",
            Self::Member => "MEMBER",
        }
    }

    pub(crate) const fn matrix_index(self) -> usize {
        match self {
            Self::Member => 0,
            Self::Receptionist => 1,
            Self::Mechanic => 2,
            Self::Admin => 3,
            Self::Executive => 4,
            Self::SuperAdmin => 5,
        }
    }
}

impl FromStr for Role {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "SUPER_ADMIN" => Ok(Self::SuperAdmin),
            "ADMIN" => Ok(Self::Admin),
            "MECHANIC" => Ok(Self::Mechanic),
            "RECEPTIONIST" => Ok(Self::Receptionist),
            "EXECUTIVE" => Ok(Self::Executive),
            "MEMBER" => Ok(Self::Member),
            _ => Err(KernelError::validation(format!("unknown role code: {raw}"))),
        }
    }
}
