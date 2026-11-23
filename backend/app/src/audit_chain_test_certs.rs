// SPDX-License-Identifier: LicenseRef-Proprietary
use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;
use std::thread;

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{DerSignature, SigningKey};
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsAcceptor;

fn der_tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 128 {
        out.push(len as u8);
    } else if len <= 0xFF {
        out.push(0x81);
        out.push(len as u8);
    } else {
        out.push(0x82);
        out.push((len >> 8) as u8);
        out.push((len & 0xFF) as u8);
    }
    out.extend_from_slice(content);
    out
}

fn random_p256_key() -> SigningKey {
    let rng = SystemRandom::new();
    loop {
        let mut raw = [0u8; 32];
        rng.fill(&mut raw).unwrap();
        if let Ok(key) = SigningKey::from_slice(&raw) {
            return key;
        }
    }
}

fn sign_cert(
    issuer_cn: &str,
    subject_cn: &str,
    serial: u8,
    subject_key: &SigningKey,
    issuer_key: &SigningKey,
    exts: &[u8],
) -> CertificateDer<'static> {
    let spki = subject_key.verifying_key().to_public_key_der().unwrap();
    let alg_id = der_tlv(
        0x30,
        &[0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02],
    );
    let name = |cn: &str| {
        let attr = der_tlv(
            0x30,
            &[
                &[0x06, 0x03, 0x55, 0x04, 0x03][..],
                &der_tlv(0x0C, cn.as_bytes()),
            ]
            .concat(),
        );
        der_tlv(0x30, &der_tlv(0x31, &attr))
    };
    let now = time::OffsetDateTime::now_utc();
    let not_before = now - time::Duration::days(1);
    let not_after = now + time::Duration::days(30);
    let fmt_utc = |t: time::OffsetDateTime| -> Vec<u8> {
        format!(
            "{:02}{:02}{:02}{:02}{:02}{:02}Z",
            t.year() % 100,
            u8::from(t.month()),
            t.day(),
            t.hour(),
            t.minute(),
            t.second()
        )
        .into_bytes()
    };
    let validity = der_tlv(
        0x30,
        &[
            &der_tlv(0x17, &fmt_utc(not_before))[..],
            &der_tlv(0x17, &fmt_utc(not_after)),
        ]
        .concat(),
    );
    let mut tbs_body = Vec::new();
    tbs_body.extend_from_slice(&[0xA0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x01, serial]);
    tbs_body.extend_from_slice(&alg_id);
    tbs_body.extend_from_slice(&name(issuer_cn));
    tbs_body.extend_from_slice(&validity);
    tbs_body.extend_from_slice(&name(subject_cn));
    tbs_body.extend_from_slice(spki.as_bytes());
    tbs_body.extend_from_slice(&der_tlv(0xA3, exts));
    let tbs = der_tlv(0x30, &tbs_body);
    let sig: DerSignature = issuer_key.sign(&tbs);
    let mut bit_string = vec![0x00];
    bit_string.extend_from_slice(&sig.to_bytes());
    CertificateDer::from(der_tlv(
        0x30,
        &[&tbs[..], &alg_id, &der_tlv(0x03, &bit_string)].concat(),
    ))
}

pub(super) fn generate_ephemeral_cert() -> (Vec<u8>, CertificateDer<'static>, PrivateKeyDer<'static>)
{
    let ca_key = random_p256_key();
    let leaf_key = random_p256_key();
    let ca_bc = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x13, 0x01, 0x01, 0xFF][..],
            &der_tlv(0x04, &der_tlv(0x30, &[0x01, 0x01, 0xFF])),
        ]
        .concat(),
    );
    let ca_ku = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x0F, 0x01, 0x01, 0xFF][..],
            &der_tlv(0x04, &[0x03, 0x02, 0x01, 0x06]),
        ]
        .concat(),
    );
    let ca_cert = sign_cert(
        "Console Test CA",
        "Console Test CA",
        1,
        &ca_key,
        &ca_key,
        &der_tlv(0x30, &[ca_bc, ca_ku].concat()),
    );

    let leaf_bc = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x13, 0x01, 0x01, 0xFF][..],
            &der_tlv(0x04, &der_tlv(0x30, &[])),
        ]
        .concat(),
    );
    let leaf_ku = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x0F, 0x01, 0x01, 0xFF][..],
            &der_tlv(0x04, &[0x03, 0x02, 0x07, 0x80]),
        ]
        .concat(),
    );
    let leaf_eku = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x25][..],
            &der_tlv(
                0x04,
                &der_tlv(
                    0x30,
                    &[0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01],
                ),
            ),
        ]
        .concat(),
    );
    let san_seq = der_tlv(
        0x30,
        &[
            &der_tlv(0x82, b"localhost")[..],
            &der_tlv(0x87, &[127, 0, 0, 1]),
        ]
        .concat(),
    );
    let leaf_san = der_tlv(
        0x30,
        &[
            &[0x06, 0x03, 0x55, 0x1D, 0x11][..],
            &der_tlv(0x04, &san_seq),
        ]
        .concat(),
    );
    let leaf_cert = sign_cert(
        "Console Test CA",
        "localhost",
        2,
        &leaf_key,
        &ca_key,
        &der_tlv(0x30, &[leaf_bc, leaf_ku, leaf_eku, leaf_san].concat()),
    );

    let b64 = BASE64.encode(ca_cert.as_ref());
    let ca_pem =
        format!("-----BEGIN CERTIFICATE-----\n{b64}\n-----END CERTIFICATE-----\n").into_bytes();
    let pkcs8_der = leaf_key.to_pkcs8_der().unwrap();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8_der.as_bytes().to_vec()));
    (ca_pem, leaf_cert, key)
}

pub(super) fn spawn_https_custody_once(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    response_bytes: Vec<u8>,
) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let cfg = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(cfg));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let std_stream = listener.accept().unwrap().0;
            std_stream.set_nonblocking(true).unwrap();
            let tokio_stream = tokio::net::TcpStream::from_std(std_stream).unwrap();
            if let Ok(mut tls) = acceptor.accept(tokio_stream).await {
                let mut req_buf = [0u8; 4096];
                let _ = tls.read(&mut req_buf).await;
                let _ = tls.write_all(&response_bytes).await;
                let _ = tls.shutdown().await;
            }
        });
    });
    (addr, handle)
}
