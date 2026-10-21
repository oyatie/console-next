// SPDX-License-Identifier: LicenseRef-Proprietary
//! Typed workplace registration answers and resolved reference values.

use serde::Serialize;

/// The create UI's route to a registration answer. The three registered
/// modes have the same domain answer once their registration exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationMode {
    New,
    Existing,
    UnitTaxationSub,
    NotRequired,
    Later,
}

impl RegistrationMode {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "NEW" => Some(Self::New),
            "EXISTING" => Some(Self::Existing),
            "UNIT_TAXATION_SUB" => Some(Self::UnitTaxationSub),
            "NOT_REQUIRED" => Some(Self::NotRequired),
            "LATER" => Some(Self::Later),
            _ => None,
        }
    }

    #[must_use]
    pub const fn is_registered(self) -> bool {
        matches!(self, Self::New | Self::Existing | Self::UnitTaxationSub)
    }
}

/// The one answer used by validation, audit events and metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkplaceRegistrationAnswer {
    Registered,
    NotRequired,
    Later,
}

impl WorkplaceRegistrationAnswer {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Registered => "REGISTERED",
            Self::NotRequired => "NOT_REQUIRED",
            Self::Later => "LATER",
        }
    }
}

/// A reference value already resolved by the use case against a loaded list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedReferenceCode {
    pub code: String,
    pub label: String,
    pub list_key: String,
    pub version: String,
    pub abstract_workplace: bool,
}
