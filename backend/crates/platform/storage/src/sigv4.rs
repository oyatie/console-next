//! P1-SIGV4: header-signed (AWS Signature Version 4) server-side S3 requests.
//! OCI Object Storage's S3 API refuses anonymous calls; SeaweedFS ignored
//! their absence, so every PUT/DELETE/HEAD/copy went out unsigned. Browser
//! uploads and downloads keep the presigned-URL form in `lib.rs`.
//! Spec: <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html>.

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, RequestBuilder};
use time::OffsetDateTime;
use url::Url;

use crate::{
    SeaweedS3Storage, StorageError, header_value, host_header, reqwest_error, sha256_hex,
    sigv4_date, sigv4_signature, sigv4_timestamp,
};

/// RFC 3986 unreserved characters stay; everything else is `%XX` (SigV4's
/// `UriEncode`, used for the canonical query string).
fn uri_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn canonical_query(url: &Url) -> String {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (uri_encode(&key), uri_encode(&value)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Add `x-amz-date`, `x-amz-content-sha256` and `Authorization` to `headers`,
/// signing `host` and every header already in `headers`.
pub(crate) fn authorize(
    storage: &SeaweedS3Storage,
    method: &Method,
    url: &Url,
    headers: &mut HeaderMap,
    body: &[u8],
    now: OffsetDateTime,
) -> Result<(), StorageError> {
    let date = sigv4_date(now);
    let amz_date = sigv4_timestamp(now);
    let payload = sha256_hex(body);
    headers.insert(
        HeaderName::from_static("x-amz-date"),
        header_value(&amz_date)?,
    );
    headers.insert(
        HeaderName::from_static("x-amz-content-sha256"),
        header_value(&payload)?,
    );
    let mut signed: Vec<(String, String)> = vec![("host".to_owned(), host_header(url)?)];
    for (name, value) in headers.iter() {
        let value = value
            .to_str()
            .map_err(|_| StorageError::S3(format!("unsignable S3 header {name}")))?;
        signed.push((name.as_str().to_owned(), value.trim().to_owned()));
    }
    signed.sort();
    let names = signed
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers: String = signed
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let canonical_request = format!(
        "{method}\n{}\n{}\n{canonical_headers}\n{names}\n{payload}",
        url.path(),
        canonical_query(url),
    );
    let scope = format!("{date}/{}/s3/aws4_request", storage.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = sigv4_signature(
        &storage.secret_access_key,
        &date,
        &storage.region,
        "s3",
        &string_to_sign,
    )?;
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}",
        storage.access_key_id
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&authorization)
            .map_err(|_| StorageError::S3("unsignable S3 credential".to_owned()))?,
    );
    Ok(())
}

impl SeaweedS3Storage {
    /// A SigV4-signed request: `headers` and `body` are what is sent.
    pub(crate) fn signed(
        &self,
        method: Method,
        url: Url,
        mut headers: HeaderMap,
        body: Vec<u8>,
    ) -> Result<RequestBuilder, StorageError> {
        authorize(
            self,
            &method,
            &url,
            &mut headers,
            &body,
            OffsetDateTime::now_utc(),
        )?;
        Ok(self.client.request(method, url).headers(headers).body(body))
    }

    /// Send a signed request.
    pub(crate) async fn s3(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, StorageError> {
        self.signed(method, url, headers, body)?
            .send()
            .await
            .map_err(reqwest_error)
    }
}

/// No headers of its own and no body (HEAD, DELETE, a GET).
impl SeaweedS3Storage {
    pub(crate) async fn s3_empty(
        &self,
        method: Method,
        url: Url,
    ) -> Result<reqwest::Response, StorageError> {
        self.s3(method, url, HeaderMap::new(), Vec::new()).await
    }
}

/// The one header most signed calls carry.
pub(crate) fn content_type(value: &str) -> Result<HeaderMap, StorageError> {
    Ok(HeaderMap::from_iter([(CONTENT_TYPE, header_value(value)?)]))
}

#[cfg(test)]
mod tests {
    use reqwest::Method;
    use reqwest::header::{HeaderMap, HeaderValue};
    use time::OffsetDateTime;
    use url::Url;

    use crate::SeaweedS3Storage;

    /// AWS's own worked example ("Example: GET Object", sig-v4-header-based-auth).
    #[test]
    fn signs_the_aws_documented_get_object_example() {
        let storage = SeaweedS3Storage::from_parts(
            reqwest::Client::new(),
            Url::parse("https://examplebucket.s3.amazonaws.com/").unwrap(),
            "us-east-1".into(),
            "AKIAIOSFODNN7EXAMPLE".into(),
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            true,
        );
        let mut headers = HeaderMap::new();
        headers.insert("range", HeaderValue::from_static("bytes=0-9"));
        let url = Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
        super::authorize(
            &storage,
            &Method::GET,
            &url,
            &mut headers,
            b"",
            OffsetDateTime::from_unix_timestamp(1_369_353_600).unwrap(),
        )
        .unwrap();
        assert_eq!(
            headers["authorization"],
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn the_canonical_query_is_sorted_and_encoded() {
        let url = Url::parse("http://h/b/k?versionId=a+b%2Fc&retention=").unwrap();
        assert_eq!(
            super::canonical_query(&url),
            "retention=&versionId=a%20b%2Fc"
        );
    }

    /// Every server-side call carries a header signature (OCI refuses anonymous ones).
    #[tokio::test]
    async fn server_side_calls_are_signed() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0_u8; 8192];
                let len = socket.read(&mut request).unwrap();
                seen.push(String::from_utf8_lossy(&request[..len]).to_lowercase());
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .unwrap();
            }
            seen
        });
        let storage = SeaweedS3Storage::from_parts(
            reqwest::Client::new(),
            endpoint,
            "ap-chuncheon-1".into(),
            "test-access".into(),
            "test-secret".into(),
            true,
        );
        storage
            .put_bytes("b", "k/a.png", "image/png", b"png".to_vec())
            .await
            .unwrap();
        storage.delete_object("b", "k/a.png").await.unwrap();
        crate::S3ObjectStore::head_object(&storage, "b".into(), "k/a.png".into())
            .await
            .unwrap();
        for request in server.join().unwrap() {
            assert!(
                request.contains("authorization: aws4-hmac-sha256 credential=test-access/")
                    && request.contains("/ap-chuncheon-1/s3/aws4_request")
                    && request.contains("x-amz-content-sha256: ")
                    && request.contains("x-amz-date: "),
                "unsigned: {request}"
            );
        }
    }
}
