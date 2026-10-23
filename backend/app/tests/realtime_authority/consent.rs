// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

impl Fixture {
    pub(super) async fn handshake(&self, cursor: Option<MessageId>) -> (TcpStream, String) {
        let mut stream = TcpStream::connect(self.addr).await.unwrap();
        let path = cursor.map_or("/api/v1/ws".to_owned(), |id| {
            format!("/api/v1/ws?last_message_id={id}")
        });
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer {}\r\n\r\n",self.addr,self.token).as_bytes()).await.unwrap();
        let header = timeout(StdDuration::from_secs(4), async {
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                assert!(bytes.len() < 8192);
                bytes.push(stream.read_u8().await.unwrap());
            }
            String::from_utf8(bytes).unwrap()
        })
        .await
        .unwrap();
        (stream, header)
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn websocket_without_current_consent_is_refused_before_upgrade(owner: PgPool) {
    let f = Fixture::new(owner, Duration::minutes(10)).await;
    sqlx::query("UPDATE auth_refresh_token_families SET privacy_acceptance=NULL WHERE id=$1")
        .bind(f.family)
        .execute(&f.owner)
        .await
        .unwrap();
    let (mut stream, header) = f.handshake(None).await;
    assert!(header.starts_with("HTTP/1.1 403"), "{header}");
    let length: usize = header
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap()
        .parse()
        .unwrap();
    assert!(length < 8192);
    let mut body = vec![0; length];
    timeout(StdDuration::from_secs(4), stream.read_exact(&mut body))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"]["code"],
        "privacy_consent_required"
    );
    assert_eq!(f.hub.connection_count().await, 0);
}
