//! 도로명주소 and 상세주소 search through the server (lane corrections #11–13).
//!
//! The keys come from the server environment (`STREET_JUSO_API_KEY`,
//! `DETAILED_JUSO_API_KEY`) and never reach the browser, git or a log line.
//! No key, a key past its declared `*_EXPIRES_ON`, a key juso rejected, a
//! timeout or any juso failure all answer `UNAVAILABLE`: the form falls back to
//! structured manual entry, never a broken field. Nothing is cached.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod config;
mod limit;
pub mod notice;
mod parse;

use std::sync::atomic::{AtomicBool, Ordering};

use console_entity_domain::KrAddress;
use serde::Serialize;
use time::{Date, OffsetDateTime, UtcOffset};
use uuid::Uuid;

pub use config::{JusoConfig, KeyConfig};
pub use notice::{KeyNotice, KeyState};
pub use parse::DetailOption;

use limit::RateLimit;
use parse::Answer;

/// Hits per page; juso caps `countPerPage` at 100.
pub const PAGE_SIZE: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SearchStatus {
    Ok,
    TooBroad,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddressSearch {
    pub status: SearchStatus,
    pub items: Vec<KrAddress>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddressDetail {
    /// `OK` (possibly with no options: the free-text 상세주소 stays) or `UNAVAILABLE`.
    pub status: SearchStatus,
    pub items: Vec<DetailOption>,
}

/// A refusal the caller maps to 422 / 429.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JusoRefusal {
    /// juso refused the keyword; the code says why (field `q`).
    InvalidQuery(&'static str),
    RateLimited,
}

/// The building a road-address hit names (its juso codes), for 상세주소.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Building {
    pub adm_cd: String,
    pub rn_mgt_sn: String,
    pub udrt_yn: bool,
    pub buld_mnnm: u32,
    pub buld_slno: u32,
}

#[derive(Debug, Clone, Copy)]
enum Api {
    Street,
    Detail,
}

/// The two proxies. Cheap to share (`Arc`); holds the per-user budget and
/// the once-per-process key-rejection flags.
#[derive(Debug)]
pub struct JusoClient {
    config: JusoConfig,
    http: Option<reqwest::Client>,
    limit: RateLimit,
    street_rejected: AtomicBool,
    detail_rejected: AtomicBool,
}

fn today_kst() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC))
        .date()
}

impl JusoClient {
    #[must_use]
    pub fn new(config: JusoConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(reqwest::Error::without_url)
            .inspect_err(|e| tracing::error!(error = %e, "juso http client unavailable"))
            .ok();
        Self {
            limit: RateLimit::new(config.per_user_per_minute),
            config,
            http,
            street_rejected: AtomicBool::new(false),
            detail_rejected: AtomicBool::new(false),
        }
    }

    fn key(&self, api: Api) -> (&KeyConfig, &AtomicBool) {
        match api {
            Api::Street => (&self.config.street, &self.street_rejected),
            Api::Detail => (&self.config.detail, &self.detail_rejected),
        }
    }

    /// The key to call with, or `None`: missing, past its declared expiry, or rejected.
    fn usable_key(&self, api: Api, today: Date) -> Option<&str> {
        let (cfg, rejected) = self.key(api);
        if rejected.load(Ordering::Relaxed) || cfg.expires_on.is_some_and(|d| d < today) {
            return None;
        }
        cfg.key.as_deref()
    }

    fn admit(&self, user: Uuid) -> Result<(), JusoRefusal> {
        let minute = u64::try_from(OffsetDateTime::now_utc().unix_timestamp() / 60).unwrap_or(0);
        if self.limit.admit(user, minute) {
            Ok(())
        } else {
            Err(JusoRefusal::RateLimited)
        }
    }

    /// GET `path` with `params` plus the key; `None` on any transport failure.
    async fn call(
        &self,
        api: Api,
        key: &str,
        path: &str,
        params: &[(&str, String)],
    ) -> Option<String> {
        let http = self.http.as_ref()?;
        let mut url = self.config.base_url.join(path).ok()?;
        url.query_pairs_mut()
            .append_pair("confmKey", key)
            .append_pair("resultType", "json")
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        // Never log the URL: it carries the key.
        let response = http
            .get(url)
            .send()
            .await
            .map_err(reqwest::Error::without_url)
            .inspect_err(|e| tracing::warn!(api = ?api, error = %e, "juso request failed"));
        response.ok()?.text().await.ok()
    }

    fn rejected(&self, api: Api) {
        let (_, flag) = self.key(api);
        if !flag.swap(true, Ordering::Relaxed) {
            // One operator-facing line per key per process, never per request.
            tracing::warn!(api = ?api, "juso refused the configured key (E0001/E0014); address search falls back to manual entry until the key is renewed");
        }
    }

    /// 도로명주소 keyword search, one page (1-based).
    ///
    /// # Errors
    /// `RateLimited` over the per-user budget; `InvalidQuery` when juso refuses the keyword.
    pub async fn search(
        &self,
        user: Uuid,
        q: &str,
        page: u32,
    ) -> Result<AddressSearch, JusoRefusal> {
        let unavailable = AddressSearch {
            status: SearchStatus::Unavailable,
            items: vec![],
            total: 0,
        };
        let Some(key) = self.usable_key(Api::Street, today_kst()) else {
            return Ok(unavailable);
        };
        self.admit(user)?;
        let params = [
            ("keyword", q.trim().to_owned()),
            ("currentPage", page.max(1).to_string()),
            ("countPerPage", PAGE_SIZE.to_string()),
        ];
        let Some(body) = self
            .call(Api::Street, key, "/addrlink/addrLinkApi.do", &params)
            .await
        else {
            return Ok(unavailable);
        };
        Ok(match parse::road(&body) {
            Answer::Ok { items, total } => AddressSearch {
                status: SearchStatus::Ok,
                items,
                total,
            },
            Answer::TooBroad => AddressSearch {
                status: SearchStatus::TooBroad,
                items: vec![],
                total: 0,
            },
            Answer::InvalidQuery(code) => return Err(JusoRefusal::InvalidQuery(code)),
            Answer::KeyRejected => {
                self.rejected(Api::Street);
                unavailable
            }
            Answer::Failed => {
                tracing::warn!("juso road search answered an error or an unreadable body");
                unavailable
            }
        })
    }

    /// 상세주소 options of one building: its 동 (no `dong`), or the 층·호 of
    /// one 동 (`dong` given; an empty `dong` lists a building without 동).
    ///
    /// # Errors
    /// `RateLimited` over the per-user budget.
    pub async fn detail(
        &self,
        user: Uuid,
        building: &Building,
        dong: Option<&str>,
    ) -> Result<AddressDetail, JusoRefusal> {
        let unavailable = AddressDetail {
            status: SearchStatus::Unavailable,
            items: vec![],
        };
        let Some(key) = self.usable_key(Api::Detail, today_kst()) else {
            return Ok(unavailable);
        };
        self.admit(user)?;
        let mut params = vec![
            ("admCd", building.adm_cd.clone()),
            ("rnMgtSn", building.rn_mgt_sn.clone()),
            (
                "udrtYn",
                if building.udrt_yn { "1" } else { "0" }.to_owned(),
            ),
            ("buldMnnm", building.buld_mnnm.to_string()),
            ("buldSlno", building.buld_slno.to_string()),
            (
                "searchType",
                if dong.is_some() { "floorho" } else { "dong" }.to_owned(),
            ),
        ];
        if let Some(d) = dong.filter(|d| !d.trim().is_empty()) {
            params.push(("dongNm", d.trim().to_owned()));
        }
        let Some(body) = self
            .call(Api::Detail, key, "/addrlink/addrDetailApi.do", &params)
            .await
        else {
            return Ok(unavailable);
        };
        Ok(match parse::detail(&body) {
            Answer::Ok { items, .. } => AddressDetail {
                status: SearchStatus::Ok,
                items,
            },
            Answer::KeyRejected => {
                self.rejected(Api::Detail);
                unavailable
            }
            Answer::TooBroad | Answer::InvalidQuery(_) | Answer::Failed => {
                tracing::warn!("juso detail search answered an error or an unreadable body");
                unavailable
            }
        })
    }

    /// Renewal notices for the platform (vendor) surface, never a tenant one.
    #[must_use]
    pub fn key_notices(&self) -> Vec<KeyNotice> {
        let today = today_kst();
        [
            ("STREET_JUSO_API_KEY", Api::Street),
            ("DETAILED_JUSO_API_KEY", Api::Detail),
        ]
        .into_iter()
        .filter_map(|(env, api)| {
            let (cfg, rejected) = self.key(api);
            notice::notice(
                env,
                cfg.key.is_some(),
                cfg.expires_on,
                rejected.load(Ordering::Relaxed),
                today,
            )
        })
        .collect()
    }
}

#[cfg(test)]
mod tests;
