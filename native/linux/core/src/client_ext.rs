//! Generic JSON access to the rune HTTP API for clients that show the library (rune desktop). Additive: rune mini only
//! uses the player routes in `net.rs`. Every call is blocking: run it on a background thread.
use crate::net::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A query string from pairs; empty values are left out (the web's `qs()` in `api.ts`).
pub fn qs(pairs: &[(&str, String)]) -> String {
    let mut u = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        if !v.is_empty() {
            u.append_pair(k, v);
        }
    }
    let s = u.finish();
    if s.is_empty() { s } else { format!("?{s}") }
}

impl Client {
    /// GET `/api{path}` as JSON. The error is the server's own `{error}` text, or "cannot reach the server".
    pub fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        self.req("GET", &format!("/api{path}")).call().map_err(Self::describe)?.into_json().map_err(|e| e.to_string())
    }

    /// POST/PUT/PATCH/DELETE `/api{path}` with an optional JSON body. An empty answer (204) is `Value::Null`.
    pub fn send_json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let r = self.req(method, &format!("/api{path}"));
        let res = match body {
            Some(b) => r.send_json(b.clone()),
            None => r.call(),
        }
        .map_err(Self::describe)?;
        let text = res.into_string().map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_strings_skip_empty_values_and_encode() {
        assert_eq!(qs(&[("q", "a b&c".into()), ("source", "".into()), ("limit", "120".into())]), "?q=a+b%26c&limit=120");
        assert_eq!(qs(&[("q", "".into())]), "");
    }
}
