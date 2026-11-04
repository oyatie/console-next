// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Controller, Kind};
use serde::{Deserialize, Serialize};

/// Self-service filing; the server supplies subject, channel, identity and receipt date.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Filing {
    pub controller: Controller,
    pub kinds: Vec<Kind>,
    #[serde(default)]
    pub detail: String,
}
