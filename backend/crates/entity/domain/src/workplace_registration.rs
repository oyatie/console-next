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

use crate::refusal::{INVALID_OPTION, Issues, NOT_APPLICABLE, REQUIRED};
use crate::workplace::WorkplaceInput;

pub(crate) fn validate_answer(
    input: &WorkplaceInput,
    resolved_reason: Option<&ResolvedReferenceCode>,
    is: &mut Issues,
) -> (
    WorkplaceRegistrationAnswer,
    Option<ResolvedReferenceCode>,
    bool,
) {
    let mode = is.choice(
        "reg_mode",
        input.reg_mode.as_deref(),
        false,
        RegistrationMode::parse,
    );
    let registration_answer = if input.registration_id.is_some() {
        if input.not_registered_reason.is_some() {
            is.push("not_registered_reason", NOT_APPLICABLE);
        }
        if matches!(
            mode,
            Some(RegistrationMode::NotRequired | RegistrationMode::Later)
        ) {
            is.push("registration_id", NOT_APPLICABLE);
        }
        WorkplaceRegistrationAnswer::Registered
    } else if mode.is_some_and(RegistrationMode::is_registered) {
        is.push("registration_id", REQUIRED);
        WorkplaceRegistrationAnswer::Registered
    } else if mode == Some(RegistrationMode::NotRequired)
        || (mode.is_none() && input.not_registered_reason.is_some())
    {
        WorkplaceRegistrationAnswer::NotRequired
    } else {
        if input.not_registered_reason.is_some() {
            is.push("not_registered_reason", NOT_APPLICABLE);
        }
        WorkplaceRegistrationAnswer::Later
    };
    let not_registered_reason = if registration_answer == WorkplaceRegistrationAnswer::NotRequired {
        match input
            .not_registered_reason
            .as_ref()
            .and_then(|reason| reason.code.as_deref())
            .map(str::trim)
            .filter(|code| !code.is_empty())
        {
            None => {
                is.push("not_registered_reason", REQUIRED);
                None
            }
            Some(code) => match resolved_reason.filter(|resolved| resolved.code == code) {
                Some(reason) => Some(reason.clone()),
                None => {
                    is.push("not_registered_reason", INVALID_OPTION);
                    None
                }
            },
        }
    } else {
        None
    };
    let is_abstract = not_registered_reason
        .as_ref()
        .is_some_and(|reason| reason.abstract_workplace);
    if input.is_abstract.is_some_and(|value| value != is_abstract) {
        is.push("is_abstract", INVALID_OPTION);
    }
    if input.is_abstract == Some(true)
        && registration_answer != WorkplaceRegistrationAnswer::NotRequired
    {
        is.push("is_abstract", NOT_APPLICABLE);
    }
    if is_abstract && input.registration_id.is_some() {
        is.push("registration_id", NOT_APPLICABLE);
    }
    if is_abstract && input.sub_serial.is_some() {
        is.push("sub_serial", NOT_APPLICABLE);
    }

    (registration_answer, not_registered_reason, is_abstract)
}
