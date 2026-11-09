// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

/// A source URL satisfying the statutory register's citation CHECK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct FilingCitationUrl(String);

impl TryFrom<String> for FilingCitationUrl {
    type Error = KernelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !value
            .strip_prefix("https://www.law.go.kr/")
            .is_some_and(|path| !path.is_empty())
            || value.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(
                KernelError::validation("filing_citation_source_url_invalid")
                    .with_code("filing_citation_source_url_invalid"),
            );
        }
        Ok(Self(value))
    }
}
