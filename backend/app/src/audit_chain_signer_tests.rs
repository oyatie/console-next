// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[path = "audit_chain_test_certs.rs"]
mod certs;

use certs::{generate_ephemeral_cert, spawn_https_custody_once};
use console_platform_audit_chain::{
    InMemoryEd25519Signer, SealSignError, SealSignTransport, SealSigner,
};

use super::*;

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn external_config_absent_and_validation_rules() {
    assert!(external_config_from_vars(|_| None).unwrap().is_none());
    let partial = vars(&[("CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF", "external:a")]);
    assert!(
        external_config_from_vars(|k| partial.get(k).cloned())
            .unwrap_err()
            .to_string()
            .contains("must be set together")
    );
    let ca_only = vars(&[(
        "CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE",
        "/tmp/nonexistent.pem",
    )]);
    assert!(external_config_from_vars(|k| ca_only.get(k).cloned()).is_err());

    let pk = hex::encode([7u8; 32]);
    for bad_url in [
        "http://custody.internal:8443/sign",
        "ftp://127.0.0.1/sign",
        "https://user:pass@custody.internal/sign",
    ] {
        let map = vars(&[
            ("CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF", "k1"),
            ("CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS", &format!("k1={pk}")),
            ("CONSOLE_AUDIT_CHAIN_CUSTODY_URL", bad_url),
        ]);
        assert!(
            external_config_from_vars(|k| map.get(k).cloned()).is_err(),
            "{bad_url}"
        );
    }
    for ok_url in [
        "https://custody.internal:8443/sign",
        "http://127.0.0.1:9/sign",
        "http://localhost:9/sign",
        "http://[::1]:9/sign",
    ] {
        let map = vars(&[
            ("CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF", "k1"),
            ("CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS", &format!("k1={pk}")),
            ("CONSOLE_AUDIT_CHAIN_CUSTODY_URL", ok_url),
        ]);
        assert!(
            external_config_from_vars(|k| map.get(k).cloned()).is_ok(),
            "{ok_url}"
        );
    }
}

#[test]
fn build_attestation_and_worker_signers() {
    let inner = InMemoryEd25519Signer::generate().unwrap();
    let key_ref = "external:selfhost:active";
    let map = vars(&[
        ("CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF", key_ref),
        (
            "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS",
            &format!("{key_ref}={}", hex::encode(inner.public_key())),
        ),
        (
            "CONSOLE_AUDIT_CHAIN_CUSTODY_URL",
            "https://127.0.0.1:9/sign",
        ),
    ]);
    let cfg = external_config_from_vars(|k| map.get(k).cloned())
        .unwrap()
        .unwrap();
    let signer = build_attestation_signer(Some(&cfg)).unwrap();
    let msg = b"seal-hash-under-test";
    assert!(
        signer
            .verify(msg, &inner.sign(msg).unwrap(), key_ref)
            .unwrap()
    );
    let attacker = InMemoryEd25519Signer::generate().unwrap();
    assert!(
        !signer
            .verify(msg, &attacker.sign(msg).unwrap(), key_ref)
            .unwrap()
    );
    assert!(build_seal_worker_signer(None, false).unwrap().is_none());
    assert!(
        build_seal_worker_signer(None, true)
            .unwrap()
            .unwrap()
            .key_ref()
            .starts_with("test:ed25519:")
    );
}

#[test]
fn https_custody_transport_signs_with_pinned_ca_and_rejects_untrusted() {
    let (ca_pem, cert, key) = generate_ephemeral_cert();
    let custody = InMemoryEd25519Signer::generate().unwrap();
    let message = b"hello-https-custody";
    let sig = custody.sign(message).unwrap();
    let body = serde_json::json!({ "signature_hex": hex::encode(&sig) }).to_string();
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes();

    let (addr, server) = spawn_https_custody_once(cert.clone(), key.clone_key(), resp);
    let url = Url::parse(&format!("https://127.0.0.1:{}/sign", addr.port())).unwrap();
    let transport = HttpCustodyTransport::try_new(
        url,
        Some("tok".into()),
        Some(&ca_pem),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(transport.sign("external:active", message).unwrap(), sig);
    server.join().unwrap();

    let (addr2, server2) = spawn_https_custody_once(
        cert,
        key,
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
    );
    let url2 = Url::parse(&format!("https://127.0.0.1:{}/sign", addr2.port())).unwrap();
    let untrusted =
        HttpCustodyTransport::try_new(url2, None, None, Duration::from_secs(5)).unwrap();
    assert!(matches!(
        untrusted.sign("k", message),
        Err(SealSignError::Unavailable(_))
    ));
    server2.join().unwrap();
}

#[test]
fn http_custody_transport_refuses_redirects_oversize_non200_and_timeouts() {
    for raw_resp in [
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:9/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", CUSTODY_MAX_RESPONSE_BYTES + 1),
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}", "x".repeat(CUSTODY_MAX_RESPONSE_BYTES + 64)),
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(raw_resp.as_bytes());
            }
        });
        let transport = HttpCustodyTransport::new(Url::parse(&format!("http://{addr}/sign")).unwrap(), None);
        assert!(matches!(transport.sign("k", b"m"), Err(SealSignError::Unavailable(_))));
        srv.join().unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let srv = thread::spawn(move || {
        let (_s, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(600));
    });
    let fast_timeout = HttpCustodyTransport::try_new(
        Url::parse(&format!("http://{addr}/sign")).unwrap(),
        None,
        None,
        Duration::from_millis(150),
    )
    .unwrap();
    assert!(matches!(
        fast_timeout.sign("k", b"m"),
        Err(SealSignError::Unavailable(_))
    ));
    srv.join().unwrap();
}

#[test]
fn http_custody_transport_signs_via_loopback_stub_and_handles_connect_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let custody = Arc::new(InMemoryEd25519Signer::generate().unwrap());
    let custody_srv = Arc::clone(&custody);
    let srv = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap();
        let body = String::from_utf8_lossy(&buf[..n])
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or("")
            .to_owned();
        let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
        let sig = custody_srv
            .sign(&hex::decode(v["message_hex"].as_str().unwrap()).unwrap())
            .unwrap();
        let resp_body = serde_json::json!({ "signature_hex": hex::encode(sig) }).to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
            resp_body.len()
        );
        stream.write_all(resp.as_bytes()).unwrap();
    });
    let transport =
        HttpCustodyTransport::new(Url::parse(&format!("http://{addr}/sign")).unwrap(), None);
    assert_eq!(
        transport.sign("k", b"hello-custody").unwrap(),
        custody.sign(b"hello-custody").unwrap()
    );
    srv.join().unwrap();
    let dead = HttpCustodyTransport::new(Url::parse("http://127.0.0.1:1/sign").unwrap(), None);
    assert!(matches!(
        dead.sign("k", b"m"),
        Err(SealSignError::Unavailable(_))
    ));
}
