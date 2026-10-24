// SPDX-License-Identifier: LicenseRef-Proprietary
//! Korean issuing-authority adapter; secret-bearing requests never enter tracing.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]
mod config;
#[cfg(test)]
mod http_tests;
mod parse;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub use config::NtsConfig;
use console_entity_application::registration_check::{
    CheckAnswer, CheckAvailability, CheckFailure, CheckKind, RegistrationCheck, UnavailableReason,
    UserValidation,
};
use console_platform_key_notice::{KeyNotice, KeyState, notice};
pub use parse::{DAILY_QUOTA, MAX_BATCH, REFLECTION_LAG_DAYS};
use serde_json::{Value, json};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Instant,
};
use time::OffsetDateTime;
use tracing::Instrument;

pub struct NtsClient {
    config: NtsConfig,
    http: Option<reqwest::Client>,
    state: AtomicU8,
    failed_at: std::sync::atomic::AtomicI64,
    limit: Mutex<(i64, u32)>,
}
impl std::fmt::Debug for NtsClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NtsClient")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}
impl NtsClient {
    #[must_use]
    pub fn new(config: NtsConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok();
        Self {
            config,
            http,
            state: AtomicU8::new(0),
            failed_at: std::sync::atomic::AtomicI64::new(0),
            limit: Mutex::new((0, 0)),
        }
    }
    #[must_use]
    pub fn key_notices(&self) -> Vec<KeyNotice> {
        if self.config.key.is_some() && self.state.load(Ordering::Relaxed) == 2 {
            return vec![KeyNotice {
                env: "NTS_BUSINESSMAN_API_KEY",
                state: KeyState::Expired,
                expires_on: self.config.expires_on,
                days_left: self
                    .config
                    .expires_on
                    .map(|d| (d - OffsetDateTime::now_utc().date()).whole_days()),
            }];
        }
        notice(
            "NTS_BUSINESSMAN_API_KEY",
            self.config.key.is_some(),
            self.config.expires_on,
            self.state.load(Ordering::Relaxed) == 1,
            OffsetDateTime::now_utc().date(),
        )
        .into_iter()
        .collect()
    }
    fn admit(&self) -> Result<(), CheckFailure> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let minute = now / 60;
        let mut limit = self
            .limit
            .lock()
            .map_err(|_| CheckFailure::Unavailable(UnavailableReason::ProviderDown))?;
        if limit.0 != minute {
            *limit = (minute, 0);
        }
        if limit.1 >= self.config.rate_per_minute {
            return Err(CheckFailure::RateLimited {
                retry_after_seconds: u64::try_from(60 - now % 60).unwrap_or(60),
                gateway_code: None,
            });
        }
        limit.1 += 1;
        Ok(())
    }
    fn response_mismatch(&self) -> CheckFailure {
        self.failed_at.store(
            OffsetDateTime::now_utc().unix_timestamp(),
            Ordering::Relaxed,
        );
        self.state.store(3, Ordering::Relaxed);
        CheckFailure::Contract {
            code: "response_number_mismatch",
        }
    }
    async fn call(&self, kind: CheckKind, body: Value) -> Result<Vec<CheckAnswer>, CheckFailure> {
        if let Some(reason) = self.availability().reason {
            return Err(CheckFailure::Unavailable(reason));
        }
        self.admit()?;
        let started = Instant::now();
        let result = self.request(kind, body).instrument(tracing::info_span!("registration_check", kind = ?kind, provider = parse::PROVIDER_VERSION)).await;
        let outcome = match &result {
            Ok(_) => "ok",
            Err(CheckFailure::RateLimited { .. }) => "rate_limited",
            Err(_) => "unavailable",
        };
        metrics::counter!("registration_check_calls_total", "kind" => format!("{kind:?}"), "outcome" => outcome).increment(1);
        metrics::histogram!("registration_check_latency_seconds")
            .record(started.elapsed().as_secs_f64());
        let unavailable = match &result {
            Err(CheckFailure::Unavailable(reason)) => Some(*reason),
            Err(CheckFailure::Contract { .. }) => Some(UnavailableReason::ProviderDown),
            _ => None,
        };
        if let Some(reason) = unavailable {
            self.failed_at.store(
                OffsetDateTime::now_utc().unix_timestamp(),
                Ordering::Relaxed,
            );
            self.state.store(
                match reason {
                    UnavailableReason::KeyRejected => 1,
                    UnavailableReason::KeyExpired => 2,
                    _ => 3,
                },
                Ordering::Relaxed,
            );
        } else if result.is_ok() {
            self.state.store(0, Ordering::Relaxed);
        }
        if let Err(CheckFailure::RateLimited {
            gateway_code: Some(code),
            ..
        }) = &result
        {
            metrics::counter!("registration_check_gateway_total", "code" => code.clone())
                .increment(1);
        }
        result
    }
    async fn request(
        &self,
        kind: CheckKind,
        body: Value,
    ) -> Result<Vec<CheckAnswer>, CheckFailure> {
        let down = || CheckFailure::Unavailable(UnavailableReason::ProviderDown);
        let mut url = self
            .config
            .base_url
            .join(match kind {
                CheckKind::Status => "status",
                CheckKind::Validate => "validate",
            })
            .map_err(|_| down())?;
        url.query_pairs_mut()
            .append_pair("serviceKey", self.config.key.as_deref().ok_or_else(down)?)
            .append_pair("returnType", "JSON");
        // No request Debug, URL, transport error or provider body may enter a log.
        let response = self
            .http
            .as_ref()
            .ok_or_else(down)?
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|_| down())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|_| down())?;
        parse::response(status, &body, kind)
    }
}
impl RegistrationCheck for NtsClient {
    fn reflection_lag_days(&self) -> i64 {
        REFLECTION_LAG_DAYS
    }
    fn max_batch(&self) -> usize {
        MAX_BATCH
    }
    fn pack(&self) -> &'static str {
        "KR"
    }
    fn availability(&self) -> CheckAvailability {
        let reason = if self.config.key.is_none() {
            Some(UnavailableReason::NotConfigured)
        } else if self
            .config
            .expires_on
            .is_some_and(|d| d < OffsetDateTime::now_utc().date())
            || self.state.load(Ordering::Relaxed) == 2
        {
            Some(UnavailableReason::KeyExpired)
        } else if self.state.load(Ordering::Relaxed) == 1 {
            Some(UnavailableReason::KeyRejected)
        } else if self.http.is_none()
            || (self.state.load(Ordering::Relaxed) == 3
                && OffsetDateTime::now_utc().unix_timestamp()
                    - self.failed_at.load(Ordering::Relaxed)
                    < 60)
        {
            Some(UnavailableReason::ProviderDown)
        } else {
            None
        };
        reason.map_or_else(CheckAvailability::available, CheckAvailability::unavailable)
    }
    fn status<'a>(
        &'a self,
        numbers: &'a [String],
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<CheckAnswer>, CheckFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            if numbers
                .iter()
                .any(|n| n.len() != 10 || !n.bytes().all(|c| c.is_ascii_digit()))
            {
                return Err(CheckFailure::Contract {
                    code: "invalid_number",
                });
            }
            let mut answers = Vec::new();
            for batch in numbers.chunks(MAX_BATCH) {
                let part = self.call(CheckKind::Status, json!({"b_no": batch})).await?;
                if part.len() != batch.len()
                    || batch
                        .iter()
                        .any(|n| part.iter().filter(|a| &a.brn_checked == n).count() != 1)
                {
                    return Err(self.response_mismatch());
                }
                answers.extend(part);
            }
            Ok(answers)
        })
    }
    fn validate<'a>(
        &'a self,
        request: &'a UserValidation,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CheckAnswer, CheckFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            let date = time::Date::parse(
                &request.opened_on,
                time::macros::format_description!("[year]-[month]-[day]"),
            );
            if request.brn.len() != 10
                || !request.brn.bytes().all(|c| c.is_ascii_digit())
                || date.is_err()
                || request.representative.trim().is_empty()
            {
                return Err(CheckFailure::Contract {
                    code: "invalid_validation_fields",
                });
            }
            let answers = self.call(CheckKind::Validate, json!({"businesses": [{"b_no": request.brn, "start_dt": request.opened_on.replace('-', ""), "p_nm": request.representative}]})).await?;
            if answers.len() != 1 || answers[0].brn_checked != request.brn {
                return Err(self.response_mismatch());
            }
            answers.into_iter().next().ok_or(CheckFailure::Contract {
                code: "missing_validation",
            })
        })
    }
}
