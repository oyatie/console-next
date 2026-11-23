// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupType {
    Full,
    Diff,
    Incr,
}

impl BackupType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Diff => "diff",
            Self::Incr => "incr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionWindow {
    Window,
    Now,
}

impl ExecutionWindow {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Now => "now",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DrillRepo {
    #[serde(rename = "1")]
    Repo1,
    #[serde(rename = "2")]
    Repo2,
    #[serde(rename = "auto")]
    Auto,
}

impl DrillRepo {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Repo1 => "1",
            Self::Repo2 => "2",
            Self::Auto => "auto",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DrillType {
    Name,
    Time,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupRequestInput {
    pub backup_type: BackupType,
    pub window: ExecutionWindow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DrillRequestInput {
    pub repo: DrillRepo,
    pub drill_type: DrillType,
    #[serde(default)]
    pub target: Option<String>,
    pub window: ExecutionWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryValidationError(pub String);

impl DrillRequestInput {
    pub fn validate(&self) -> Result<(), RecoveryValidationError> {
        let target = self
            .target
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(t) = target
            && (t.chars().any(|c| c.is_control() || c.is_whitespace())
                || matches!(t, "No data" | "N/A" | "—"))
        {
            return Err(RecoveryValidationError(
                "drill target must not contain whitespace or control characters".to_owned(),
            ));
        }
        match self.drill_type {
            DrillType::Time => {
                let Some(ts) = target else {
                    return Err(RecoveryValidationError(
                        "drill_type=time requires an RFC3339 UTC target timestamp".to_owned(),
                    ));
                };
                if !ts.ends_with('Z') || OffsetDateTime::parse(ts, &Rfc3339).is_err() {
                    return Err(RecoveryValidationError(
                        "drill_type=time target must be RFC3339 UTC ending with 'Z'".to_owned(),
                    ));
                }
            }
            DrillType::Name => {}
        }
        Ok(())
    }
}
