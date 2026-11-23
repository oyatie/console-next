// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_storage::{CopyObjectRequest, S3ObjectStore, SeaweedS3Storage};
use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;
use time::{Duration, OffsetDateTime};

#[tokio::test]
async fn retained_copy_fails_without_a_version_or_when_its_retention_write_is_refused()
-> Result<(), Box<dyn std::error::Error>> {
    for (version, expected_error) in [
        ("null", "retained copy has no version ID"),
        ("copied-version", "put object retention failed with 403"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let endpoint = format!("http://{}", listener.local_addr()?).parse()?;
        let server = std::thread::spawn(move || -> io::Result<()> {
            let (mut copy, _) = listener.accept()?;
            let mut request = String::new();
            BufReader::new(&copy).read_line(&mut request)?;
            write!(
                copy,
                "HTTP/1.1 200 OK\r\nx-amz-version-id: {version}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
            if version != "null" {
                let (mut lock, _) = listener.accept()?;
                request.clear();
                BufReader::new(&lock).read_line(&mut request)?;
                assert!(
                    request.starts_with("PUT /replica/key?retention=&versionId=copied-version ")
                );
                lock.write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )?;
            }
            Ok(())
        });
        let storage = SeaweedS3Storage::from_parts(
            reqwest::Client::new(),
            endpoint,
            "us-east-1".into(),
            "test".into(),
            "test".into(),
            true,
        );
        let error = storage
            .copy_object(CopyObjectRequest {
                source_bucket: "primary".into(),
                source_key: "key".into(),
                destination_bucket: "replica".into(),
                destination_key: "key".into(),
                retain_until: Some(OffsetDateTime::now_utc() + Duration::days(1)),
            })
            .await
            .err()
            .ok_or("copy reported success")?;
        assert!(error.to_string().contains(expected_error), "{error}");
        server.join().map_err(|_| "storage fixture failed")??;
    }
    Ok(())
}
