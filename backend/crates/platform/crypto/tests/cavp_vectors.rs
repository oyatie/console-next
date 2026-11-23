// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use aws_lc_rs::{
    aead, hkdf,
    key_wrap::{AES_256, AesKek, KeyWrapPadded},
};
use console_platform_crypto::{KekId, unwrap_dek_kwp, wrap_dek_kwp};
use secrecy::{ExposeSecret, SecretBox};

fn unhex(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

struct BytesLen(usize);
impl hkdf::KeyType for BytesLen {
    fn len(&self) -> usize {
        self.0
    }
}

#[test]
fn nist_cavp_aes256_gcm_vectors_match() {
    for (key, iv, pt, aad, ct, tag) in [
        (
            "b52c505a37d78eda5dd34f20c22540ea1b58963cf8e5bf8ffa85f9f2492505b4",
            "516c33929df5a3284ff463d7",
            "",
            "",
            "",
            "bdc1ac884d332457a1d2664f168c76f0",
        ),
        (
            "31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22",
            "0d18e06c7c725ac9e362e1ce",
            "2db5168e932556f8089a0622981d017d",
            "",
            "fa4362189661d163fcd6a56d8bf0405a",
            "d636ac1bbedd5cc3ee727dc2ab4a9489",
        ),
        (
            "92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b",
            "ac93a1a6145299bde902f21a",
            "2d71bcfa914e4ac045b2aa60955fad24",
            "1e0889016f67601c8ebea4943bc23ad6",
            "8995ae2e6df3dbf96fac7b7137bae67f",
            "eca5aa77d51d4a0a14d9c51e1da474ab",
        ),
    ] {
        let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &unhex(key)).unwrap();
        let nonce: [u8; 12] = unhex(iv).try_into().unwrap();
        let mut buf = unhex(pt);
        aead::LessSafeKey::new(unbound)
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(unhex(aad)),
                &mut buf,
            )
            .unwrap();
        assert_eq!(buf, unhex(&format!("{ct}{tag}")));
    }
}

#[test]
fn rfc5869_hkdf_sha256_test_case_1_and_2() {
    // RFC 5869 Appendix A.1
    let salt1 = hkdf::Salt::new(hkdf::HKDF_SHA256, &unhex("000102030405060708090a0b0c"));
    let prk1 = salt1.extract(&unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"));
    let info1 = unhex("f0f1f2f3f4f5f6f7f8f9");
    let mut okm1 = [0u8; 42];
    prk1.expand(&[info1.as_slice()], BytesLen(42))
        .unwrap()
        .fill(&mut okm1)
        .unwrap();
    assert_eq!(
        okm1.as_slice(),
        unhex(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
        .as_slice()
    );

    // RFC 5869 Appendix A.2 (longer inputs)
    let salt2 = hkdf::Salt::new(
        hkdf::HKDF_SHA256,
        &unhex(
            "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f\
             808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f\
             a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
        ),
    );
    let ikm2 = unhex(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\
         202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f\
         404142434445464748494a4b4c4d4e4f",
    );
    let info2 = unhex(
        "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf\
         d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef\
         f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
    );
    let prk2 = salt2.extract(&ikm2);
    let mut okm2 = [0u8; 82];
    prk2.expand(&[info2.as_slice()], BytesLen(82))
        .unwrap()
        .fill(&mut okm2)
        .unwrap();
    assert_eq!(
        okm2.as_slice(),
        unhex(
            "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c\
             59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71\
             cc30c58179ec3e87c14c01d5c1f3434f1d87"
        )
        .as_slice()
    );
}

#[test]
fn nist_sp800_38f_aes256_kwp_known_answer_and_domain_separation() {
    // RFC 5649 Section 6 Examples 1-2 use 192-bit KEKs, while aws-lc-rs exposes AES-128 and
    // AES-256 KWP. NIST SP 800-38F standardizes the same KWP algorithm; verify official
    // NIST SP 800-38F KWP-AE / KWP-AD 256-bit KAT vectors (positive + authentication failure).
    for (kek_hex, pt_hex, expected_ct_hex) in [
        (
            "95da2700ca6fd9a52554ee2a8df1386f5b94a1a60ed8a4aef60a8d61ab5f225a",
            "d1",
            "06ba7ae6f3248cfdcf267507fa001bc4",
        ),
        (
            "e9bb7f44c7baafbf392ab912589a2f8db53268106eafb74689bb1833136e6113",
            "ffe952604834bff899e63658f34246815c91597eb40a21729e0a8a959b61f2",
            "15b9f06fbc765e5e3d55d6b824616f21921d2a6918ee7bf1406b524274e170b4a78333ca5ee92af5",
        ),
    ] {
        let kek_bytes = unhex(kek_hex);
        let plain = unhex(pt_hex);
        let expected_ct = unhex(expected_ct_hex);
        let mut wrapped_buf = [0u8; 40];
        let wrapped = AesKek::new(&AES_256, &kek_bytes)
            .unwrap()
            .wrap_with_padding(&plain, &mut wrapped_buf)
            .unwrap();
        assert_eq!(wrapped, expected_ct.as_slice());

        let mut out_buf = [0u8; 40];
        let unwrapped = AesKek::new(&AES_256, &kek_bytes)
            .unwrap()
            .unwrap_with_padding(wrapped, &mut out_buf)
            .unwrap();
        assert_eq!(unwrapped, plain.as_slice());
    }

    for (kek_hex, ct_hex, expected_pt_hex) in [
        (
            "20e4ff6a88ffa9a2818b81702793d8a016722c2fa1ff445f24b9db293cb12069",
            "85011dc927b167f411b0b8e21b11d819",
            "d2",
        ),
        (
            "09ab4286a845c18bb481da91c39a58fd52ed78d54973fc41f25163a0c33f4727",
            "0a180a84b01fc1e44b9f9301cc89af95de758219015abc86c3e48e764e7379246ae7209aaa4f889d",
            "4c1b6accb492c88b10a56a56eb9b6d6ed9797056a559fe3f0c7c0429a200af",
        ),
    ] {
        let mut out_buf = [0u8; 40];
        let unwrapped = AesKek::new(&AES_256, &unhex(kek_hex))
            .unwrap()
            .unwrap_with_padding(&unhex(ct_hex), &mut out_buf)
            .unwrap();
        assert_eq!(unwrapped, unhex(expected_pt_hex).as_slice());
    }

    for (kek_hex, bad_ct_hex) in [
        (
            "c32cb3e1e41a4b9f4de79989957866f5dd48dba38c22a6ebb80e14c84bdd9534",
            "c29b05c2619a58ecc1d239e7a34273cd",
        ),
        (
            "8c35fb77766d04f48d5b52275c5c5f31f568078419e5c2335918965fbe53cedd",
            "bacccb1714dbaa4908c2654aa8dbb1ddbddd8ab819429b026619fb1c0fa75a8247372b2feeab1e1d",
        ),
    ] {
        let mut out_buf = [0u8; 40];
        assert!(
            AesKek::new(&AES_256, &unhex(kek_hex))
                .unwrap()
                .unwrap_with_padding(&unhex(bad_ct_hex), &mut out_buf)
                .is_err()
        );
    }

    // Domain-separated KWP in console-platform-crypto
    let master = SecretBox::new(Box::new([0x33u8; 32]));
    let dek = SecretBox::new(Box::new([0x77u8; 32]));
    let k1 = KekId::new("kek-a").unwrap();
    let k2 = KekId::new("kek-b").unwrap();
    let w_cred = wrap_dek_kwp(&master, &k1, "credential", &dek).unwrap();
    let w_rrn = wrap_dek_kwp(&master, &k1, "rrn_vault", &dek).unwrap();
    let w_k2 = wrap_dek_kwp(&master, &k2, "credential", &dek).unwrap();
    assert_eq!(w_cred.len(), 40);
    assert_ne!(w_cred, w_rrn);
    assert_ne!(w_cred, w_k2);

    let opened = unwrap_dek_kwp(&master, &k1, "credential", &w_cred).unwrap();
    assert_eq!(opened.expose_secret(), dek.expose_secret());
    assert!(unwrap_dek_kwp(&master, &k1, "rrn_vault", &w_cred).is_err());
    assert!(unwrap_dek_kwp(&master, &k2, "credential", &w_cred).is_err());
}
