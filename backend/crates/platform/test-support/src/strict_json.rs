use axum::body::Body;
use axum::extract::FromRequest;
use axum::http::{Request, StatusCode};
use std::future::Future;
use std::task::{Context, Poll, Waker};

/// Exercise Axum's actual JSON extractor, including its HTTP refusal status.
pub fn rejects_unknown<T: serde::de::DeserializeOwned>() {
    assert_unknown::<T>(r#"{"__unknown_field__":true}"#.to_owned());
}

pub fn rejects_unknown_with<T: serde::de::DeserializeOwned>(mut valid: serde_json::Value) {
    assert!(
        serde_json::from_value::<T>(valid.clone()).is_ok(),
        "known fields must still decode"
    );
    valid
        .as_object_mut()
        .unwrap()
        .insert("__unknown_field__".into(), true.into());
    assert_unknown::<T>(valid.to_string());
}

fn assert_unknown<T: serde::de::DeserializeOwned>(body: String) {
    let request = Request::builder()
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let mut future = Box::pin(axum::Json::<T>::from_request(request, &()));
    let Poll::Ready(result) = future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    else {
        panic!("in-memory request body unexpectedly pending");
    };
    let error = result.err().expect("unknown field must be refused");
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        error
            .body_text()
            .contains("unknown field `__unknown_field__`"),
        "{}",
        error.body_text()
    );
}
