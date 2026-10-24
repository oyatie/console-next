// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tracing_subscriber::fmt::MakeWriter;
use url::Url;
type Requests = Arc<Mutex<Vec<(String, Value)>>>;
/// `None` echoes the requested numbers; a fixed response replays errors.
pub(super) async fn serve(fixed: Option<(u16, &'static str)>) -> (Url, Requests) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let requests: Requests = Arc::default();
    let captured = requests.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let captured = captured.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let (line, body) = loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..n]);
                    let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if bytes.len() < end + 4 + length {
                        continue;
                    }
                    break (
                        headers.lines().next().unwrap().to_owned(),
                        serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length]).unwrap(),
                    );
                };
                captured.lock().unwrap().push((line.clone(), body.clone()));
                if fixed.is_some_and(|(_, body)| body == "timeout") {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    return;
                }
                let (status, answer) = fixed.map_or_else(|| {
                    let data: Vec<Value> = if line.starts_with("POST /validate?") {
                        body["businesses"].as_array().unwrap().iter().map(|v| json!({"b_no":v["b_no"],"valid":"01","status":{"b_stt_cd":"01","tax_type_cd":"01"}})).collect()
                    } else {
                        body["b_no"].as_array().unwrap().iter().map(|n| json!({"b_no":n,"b_stt_cd":"01","tax_type_cd":"01"})).collect()
                    };
                    (200, json!({"status_code":"OK","data":data}).to_string())
                }, |(status, body)| (status, body.into()));
                let response = format!(
                    "HTTP/1.1 {status} Replay\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, requests)
}

#[derive(Clone, Default)]
pub(super) struct Log(pub(super) Arc<Mutex<Vec<u8>>>);
impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> MakeWriter<'a> for Log {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}
