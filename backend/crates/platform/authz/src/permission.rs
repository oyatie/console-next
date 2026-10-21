use std::str::FromStr;

use console_kernel_core::KernelError;

/// Permission-cell semantics from the inherited Korean matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    Deny,
    RequestOnly,
    Limited,
    Allow,
}

impl PermissionLevel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::RequestOnly => "request_only",
            Self::Limited => "limited",
            Self::Allow => "allow",
        }
    }

    pub(crate) const fn satisfies(self, required: Self) -> bool {
        match required {
            Self::Deny => true,
            Self::Allow => matches!(self, Self::Allow),
            Self::Limited => matches!(self, Self::Allow | Self::Limited),
            Self::RequestOnly => matches!(self, Self::Allow | Self::RequestOnly),
        }
    }
}

impl FromStr for PermissionLevel {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "deny" => Ok(Self::Deny),
            "request_only" => Ok(Self::RequestOnly),
            "limited" => Ok(Self::Limited),
            "allow" => Ok(Self::Allow),
            _ => Err(KernelError::validation(format!(
                "unknown permission level: {raw}"
            ))),
        }
    }
}
