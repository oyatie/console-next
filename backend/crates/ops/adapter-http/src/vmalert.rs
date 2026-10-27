// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_application::vmalert::{RuleAlert, RuleGroup};
use console_ops_application::{SourceError, SourceFuture, Vmalert, VmalertSnapshot};
use serde::Deserialize;

use crate::{HttpReadLimits, HttpSource};

pub struct HttpVmalert {
    source: HttpSource,
}

impl HttpVmalert {
    pub fn new(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new(base_url, interval_s, limits)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "status", content = "data", rename_all = "lowercase")]
enum Response<T> {
    Success(T),
}

#[derive(Deserialize)]
struct Rules {
    groups: Vec<RuleGroup>,
}

#[derive(Deserialize)]
struct Alerts {
    alerts: Vec<RuleAlert>,
}

impl Vmalert for HttpVmalert {
    fn read(&self) -> SourceFuture<'_, VmalertSnapshot> {
        Box::pin(async {
            let (Response::Success(rules), Response::Success(alerts)) = tokio::try_join!(
                self.source.get::<Response<Rules>>("api/v1/rules"),
                self.source.get::<Response<Alerts>>("api/v1/alerts"),
            )?;
            if rules.groups.iter().any(|group| {
                group.id.is_empty()
                    || group.name.is_empty()
                    || group.rules.iter().any(|rule| {
                        rule.id.is_empty() || rule.name.is_empty() || rule.query.is_empty()
                    })
            }) || alerts.alerts.iter().any(|alert| {
                alert.labels.get("alertname").is_none_or(String::is_empty)
                    || alert.rule_id.is_empty()
                    || alert.group_id.is_empty()
                    || alert.expression.is_empty()
            }) {
                return Err(SourceError::Invalid);
            }
            Ok(VmalertSnapshot {
                groups: rules.groups,
                alerts: alerts.alerts,
            })
        })
    }
}
