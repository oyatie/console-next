//! The authority: Cloudflare's DNS records API, read with a Zone:DNS:Read token.

use std::time::Duration;

use serde_json::Value;

use crate::{BoxFuture, CnameReader, FenceReadError, LiveFenceConfig};

/// One read may take at most this long; a hung read counts as a failed one.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CloudflareCnameReader {
    client: reqwest::Client,
    url: String,
    token: String,
}

impl CloudflareCnameReader {
    pub fn new(config: &LiveFenceConfig) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder().timeout(READ_TIMEOUT).build()?;
        Ok(Self {
            client,
            url: format!(
                "{}/zones/{}/dns_records?type=CNAME&name={}",
                config.api_base, config.zone_id, config.record_name
            ),
            token: config.api_token.clone(),
        })
    }
}

impl CnameReader for CloudflareCnameReader {
    fn read(&self) -> BoxFuture<'_, Result<Option<String>, FenceReadError>> {
        Box::pin(async move {
            let response = self
                .client
                .get(&self.url)
                .bearer_auth(&self.token)
                .send()
                .await
                .map_err(|err| FenceReadError(err.without_url().to_string()))?;
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|err| FenceReadError(err.without_url().to_string()))?;
            if !status.is_success() {
                return Err(FenceReadError(format!("HTTP {status}")));
            }
            parse_records(&body)
        })
    }
}

/// `{"success":true,"result":[{"content":"…"}]}`: one record → its content,
/// none → `None` (positive evidence the CNAME is not ours). Anything else is a
/// failed read.
pub(crate) fn parse_records(body: &str) -> Result<Option<String>, FenceReadError> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| FenceReadError(format!("bad JSON: {err}")))?;
    if value.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(FenceReadError("API answered success != true".to_owned()));
    }
    let records = value
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| FenceReadError("no result array".to_owned()))?;
    match records.as_slice() {
        [] => Ok(None),
        [record] => record
            .get("content")
            .and_then(Value::as_str)
            .map(|content| Some(content.to_owned()))
            .ok_or_else(|| FenceReadError("record without content".to_owned())),
        _ => Err(FenceReadError(format!("{} CNAME records", records.len()))),
    }
}
