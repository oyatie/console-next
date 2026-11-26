// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_storage::{CopyObjectRequest, S3ObjectStore, SeaweedS3Storage, StorageError};
use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;
use time::{Duration, OffsetDateTime};

#[tokio::test]
async fn retained_copy_fails_without_a_version_or_when_its_retention_write_is_refused()
-> Result<(), Box<dyn std::error::Error>> {
    for version in ["null", "copied-version"] {
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
        if version == "null" {
            assert!(
                matches!(&error, StorageError::S3(message) if message == "retained copy has no version ID"),
                "{error}"
            );
        } else {
            assert!(
                matches!(&error, StorageError::Response { operation, status: 403, code }
                if operation == "put object retention" && code.is_empty()),
                "{error}"
            );
        }
        server.join().map_err(|_| "storage fixture failed")??;
    }
    Ok(())
}
