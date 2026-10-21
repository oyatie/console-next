//! `send_rendered`: a message the caller (the mail worker) has already
//! rendered, with its own extra headers (MAIL design §4.3: `Feedback-ID`,
//! `X-Mox-Extra-*`, `Auto-Submitted`).
//!
//! The envelope never comes from the caller: the sender address is the
//! configured one, the only recipient is `to`, and an extra header can never
//! name or replace an addressing or structural header, nor smuggle a line
//! break into the message.

use lettre::Message;
use lettre::message::header::{HeaderName, HeaderValue};
use lettre::message::{Mailbox, MultiPart, SinglePart};

use crate::{EmailError, SmtpEmailConfig};

/// One rendered message for one recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedEmail {
    pub to: String,
    /// Display name for the configured sender address; `None` keeps the
    /// configured `from_name`.
    pub from_name: Option<String>,
    pub subject: String,
    pub text: String,
    /// Sent as `multipart/alternative` beside `text` when present.
    pub html: Option<String>,
    /// Extra headers, in order. See [`RESERVED_HEADERS`].
    pub headers: Vec<(String, String)>,
}

/// Headers the builder owns: addressing (the envelope is derived from them)
/// and MIME structure. An extra header with one of these names is refused.
pub const RESERVED_HEADERS: [&str; 13] = [
    "from",
    "sender",
    "reply-to",
    "to",
    "cc",
    "bcc",
    "subject",
    "date",
    "return-path",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
];

pub(crate) fn build_message(
    config: &SmtpEmailConfig,
    email: &RenderedEmail,
) -> Result<Message, EmailError> {
    let address = config
        .from_address
        .parse()
        .map_err(|err| EmailError::Message(format!("invalid from address: {err}")))?;
    let from_name = email
        .from_name
        .clone()
        .unwrap_or_else(|| config.from_name.clone());
    if has_line_break(&from_name) || has_line_break(&email.subject) {
        return Err(EmailError::Message(
            "from name and subject must be one line".to_owned(),
        ));
    }
    let mut builder = Message::builder()
        .from(Mailbox::new(Some(from_name), address))
        .to(email
            .to
            .parse()
            .map_err(|err| EmailError::Message(format!("invalid recipient address: {err}")))?)
        .subject(email.subject.clone());
    for (name, value) in &email.headers {
        builder = builder.raw_header(extra_header(name, value)?);
    }
    let built = match &email.html {
        None => builder.singlepart(SinglePart::plain(email.text.clone())),
        Some(html) => builder.multipart(MultiPart::alternative_plain_html(
            email.text.clone(),
            html.clone(),
        )),
    };
    built.map_err(|err| EmailError::Message(err.to_string()))
}

fn extra_header(name: &str, value: &str) -> Result<HeaderValue, EmailError> {
    // RFC 5322 §2.2 field name: printable US-ASCII except ':'.
    let printable = !name.is_empty() && name.bytes().all(|b| (33..=126).contains(&b) && b != b':');
    if !printable || RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(EmailError::Message(format!(
            "extra header name {name:?} is not allowed"
        )));
    }
    if has_line_break(value) {
        return Err(EmailError::Message(format!(
            "extra header {name} must be one line"
        )));
    }
    let name = HeaderName::new_from_ascii(name.to_owned())
        .map_err(|_| EmailError::Message(format!("extra header name {name:?} is not allowed")))?;
    Ok(HeaderValue::new(name, value.to_owned()))
}

fn has_line_break(value: &str) -> bool {
    value.contains(['\r', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SmtpEmailConfig {
        SmtpEmailConfig {
            host: "mail.invalid".to_owned(),
            port: 587,
            username: "no-reply".to_owned(),
            password: "secret".to_owned(),
            from_address: "no-reply@example.com".to_owned(),
            from_name: "HANU".to_owned(),
        }
    }

    fn email() -> RenderedEmail {
        RenderedEmail {
            to: "person@example.com".to_owned(),
            from_name: Some("Acme (HANU)".to_owned()),
            subject: "Invitation".to_owned(),
            text: "Your code".to_owned(),
            html: Some("<p>Your code</p>".to_owned()),
            headers: vec![
                (
                    "Feedback-ID".to_owned(),
                    "INVITE:tenant:org1:saeonlogi".to_owned(),
                ),
                ("X-Mox-Extra-mid".to_owned(), "m-1".to_owned()),
                ("Auto-Submitted".to_owned(), "auto-generated".to_owned()),
            ],
        }
    }

    fn formatted(email: &RenderedEmail) -> String {
        String::from_utf8(build_message(&config(), email).unwrap().formatted()).unwrap()
    }

    #[test]
    fn extra_headers_and_both_parts_are_present() {
        let raw = formatted(&email());
        for line in [
            "Feedback-ID: INVITE:tenant:org1:saeonlogi\r\n",
            "X-Mox-Extra-mid: m-1\r\n",
            "Auto-Submitted: auto-generated\r\n",
            // "Acme (HANU)", RFC 2047-encoded by lettre (parentheses are specials).
            "From: =?utf-8?b?QWNtZSAoSEFOVSk=?= <no-reply@example.com>\r\n",
            "To: person@example.com\r\n",
        ] {
            assert!(raw.contains(line), "missing {line:?} in\n{raw}");
        }
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("text/html"), "{raw}");
    }

    #[test]
    fn text_only_message_is_a_single_part() {
        let raw = formatted(&RenderedEmail {
            html: None,
            from_name: None,
            ..email()
        });
        assert!(!raw.contains("multipart"), "{raw}");
        assert!(
            raw.contains("From: HANU <no-reply@example.com>\r\n"),
            "{raw}"
        );
    }

    #[test]
    fn addressing_and_structural_headers_are_refused() {
        for name in ["Bcc", "to", "FROM", "Reply-To", "Content-Type", "Subject"] {
            let mut message = email();
            message.headers = vec![(name.to_owned(), "attacker@example.com".to_owned())];
            assert!(
                matches!(
                    build_message(&config(), &message),
                    Err(EmailError::Message(_))
                ),
                "{name} was accepted"
            );
        }
    }

    #[test]
    fn line_breaks_and_bad_names_are_refused() {
        let cases = [
            ("X-Ok", "a\r\nBcc: attacker@example.com"),
            ("X-Ok", "a\nb"),
            ("X Bad", "v"),
            ("X:Bad", "v"),
            ("X-\r\nBcc", "v"),
            ("", "v"),
        ];
        for (name, value) in cases {
            let mut message = email();
            message.headers = vec![(name.to_owned(), value.to_owned())];
            assert!(
                build_message(&config(), &message).is_err(),
                "{name:?}: {value:?} was accepted"
            );
        }
        let mut subject = email();
        subject.subject = "hi\r\nBcc: attacker@example.com".to_owned();
        assert!(build_message(&config(), &subject).is_err());
        let mut from_name = email();
        from_name.from_name = Some("x\nBcc: a@example.com".to_owned());
        assert!(build_message(&config(), &from_name).is_err());
    }
}
