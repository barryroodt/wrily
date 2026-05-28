use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};
use wrily_rig::cli::Provider;
use wrily_rig::provider::{
    build_adapter, ChatMessage, CursorProvider, ProviderAdapter, ToolSchema,
};

struct EnvVarGuard {
    vars: Vec<(String, Option<String>)>,
}

impl EnvVarGuard {
    fn set(key: &str, value: Option<&str>) -> Self {
        let previous = std::env::var(key).ok();
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        Self {
            vars: vec![(key.to_string(), previous)],
        }
    }

    fn set_many(pairs: &[(&str, Option<&str>)]) -> Self {
        let mut vars = Vec::with_capacity(pairs.len());
        for (key, value) in pairs {
            let previous = std::env::var(key).ok();
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            vars.push(((*key).to_string(), previous));
        }
        Self { vars }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, previous) in self.vars.drain(..) {
            match previous {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/cursor")
        .join(name)
}

fn jsonl_fixture_to_sse(path: &PathBuf) -> String {
    let raw = fs::read_to_string(path).expect("read fixture");
    let mut body = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event: Value = serde_json::from_str(line).expect("valid fixture JSON");
        let event_name = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        body.push_str(&format!("event: {event_name}\n"));
        body.push_str(&format!("data: {line}\n\n"));
    }
    body
}

fn bridge_url(mock_server: &MockServer) -> String {
    mock_server.uri()
}

#[test]
fn new_accepts_composer_model_aliases() {
    let _env = EnvVarGuard::set("CURSOR_API_KEY", Some("crsr_test_key"));
    for model in [
        "composer-2.5",
        "composer-2.5-fast",
        "cursor-composer-2.5",
        "cursor-composer-2.5-fast",
    ] {
        let provider = CursorProvider::new(model.into()).expect("provider");
        match model {
            "composer-2.5" | "cursor-composer-2.5" => {
                assert_eq!(provider.model(), "composer-2.5");
            }
            "composer-2.5-fast" | "cursor-composer-2.5-fast" => {
                assert_eq!(provider.model(), "composer-2.5-fast");
            }
            _ => {}
        }
    }
}

#[test]
fn new_rejects_openai_compat_models() {
    let _env = EnvVarGuard::set("CURSOR_API_KEY", Some("crsr_test_key"));
    let result = CursorProvider::new("gpt-4o".into());
    assert!(result.is_err(), "expected OpenAI model to be rejected");
    let err = result.err().expect("error").to_string();
    assert!(
        err.contains("unsupported Cursor model"),
        "unexpected error: {err}"
    );
}

#[test]
fn new_errors_when_api_key_missing() {
    let _env = EnvVarGuard::set("CURSOR_API_KEY", None);
    let result = CursorProvider::new("composer-2.5".into());
    assert!(result.is_err(), "expected missing API key to fail");
    assert_eq!(
        result.err().expect("error").to_string(),
        "CURSOR_API_KEY not set"
    );
}

#[test]
fn build_adapter_cursor_requires_api_key() {
    let _env = EnvVarGuard::set("CURSOR_API_KEY", None);
    let result = build_adapter(Provider::Cursor, "composer-2.5".into());
    assert!(result.is_err());
    assert!(result
        .err()
        .expect("error")
        .to_string()
        .contains("CURSOR_API_KEY not set"));
}

#[tokio::test]
async fn complete_against_bridge_fixture_maps_text_tools_and_usage() {
    let mock_server = MockServer::start().await;
    let captured = Arc::new(Mutex::new(None::<Value>));
    let captured_for_mock = Arc::clone(&captured);
    let sse_body = jsonl_fixture_to_sse(&fixture_path("composer-2.5-turn.jsonl"));

    Mock::given(method("POST"))
        .and(path("/v1/turns"))
        .respond_with(move |request: &Request| {
            let body = serde_json::from_slice::<Value>(&request.body)
                .expect("request body should be valid JSON");
            *captured_for_mock.lock().expect("capture lock") = Some(body);
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body.clone())
        })
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("CURSOR_API_KEY", Some("crsr_test_key")),
        ("CURSOR_BRIDGE_URL", Some(bridge_url(&mock_server).as_str())),
    ]);

    let provider = CursorProvider::new("composer-2.5".into()).expect("provider");
    let tools = [ToolSchema {
        name: "get_weather".into(),
        description: "Get weather for a city".into(),
        json_schema: json!({
            "type": "object",
            "properties": {
                "city": { "type": "string" }
            },
            "required": ["city"]
        }),
    }];

    let response = provider
        .complete(
            "You are a helpful assistant.",
            &[ChatMessage::User("What's the weather in Paris?".into())],
            &tools,
        )
        .await
        .expect("complete");

    assert_eq!(response.text, "I'll check the weather for you.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "call_weather_1");
    assert_eq!(response.tool_calls[0].name, "get_weather");
    assert_eq!(response.tool_calls[0].args_json, r#"{"city":"Paris"}"#);
    assert_eq!(response.input_tokens, 100);
    assert_eq!(response.output_tokens, 25);
    assert_eq!(response.cache_read, 800);
    assert_eq!(response.cache_write, 100);

    let request_body = captured
        .lock()
        .expect("capture lock")
        .clone()
        .expect("request body captured");
    assert_eq!(request_body["model"], "composer-2.5");
    assert_eq!(request_body["system"], "You are a helpful assistant.");
    assert_eq!(request_body["messages"][0]["role"], "user");
    assert_eq!(request_body["tools"][0]["name"], "get_weather");
    assert!(request_body.get("cwd").is_some());
}

#[tokio::test]
async fn complete_maps_turn_ended_usage_to_provider_response_tokens() {
    let mock_server = MockServer::start().await;
    let sse_body = jsonl_fixture_to_sse(&fixture_path("composer-2.5-turn.jsonl"));

    Mock::given(method("POST"))
        .and(path("/v1/turns"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("CURSOR_API_KEY", Some("crsr_test_key")),
        ("CURSOR_BRIDGE_URL", Some(bridge_url(&mock_server).as_str())),
    ]);

    let provider = CursorProvider::new("cursor-composer-2.5".into()).expect("provider");
    let response = provider
        .complete("System", &[ChatMessage::User("hello".into())], &[])
        .await
        .expect("complete");

    assert_eq!(response.input_tokens, 100);
    assert_eq!(response.output_tokens, 25);
    assert_eq!(response.cache_read, 800);
    assert_eq!(response.cache_write, 100);
}

#[tokio::test]
async fn complete_preserves_parallel_tool_call_emission_order() {
    let mock_server = MockServer::start().await;
    let sse_body = jsonl_fixture_to_sse(&fixture_path("composer-2.5-parallel-tools.jsonl"));

    Mock::given(method("POST"))
        .and(path("/v1/turns"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("CURSOR_API_KEY", Some("crsr_test_key")),
        ("CURSOR_BRIDGE_URL", Some(bridge_url(&mock_server).as_str())),
    ]);

    let provider = CursorProvider::new("composer-2.5".into()).expect("provider");
    let response = provider
        .complete("System", &[ChatMessage::User("Run both tools".into())], &[])
        .await
        .expect("complete");

    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "call_first");
    assert_eq!(response.tool_calls[0].name, "search");
    assert_eq!(
        response.tool_calls[0].args_json,
        r#"{"query":"rig harness"}"#
    );
    assert_eq!(response.tool_calls[1].id, "call_second");
    assert_eq!(response.tool_calls[1].name, "read_file");
    assert_eq!(response.tool_calls[1].args_json, r#"{"path":"README.md"}"#);
}

#[tokio::test]
#[ignore = "requires live CURSOR_API_KEY and running cursor SDK bridge"]
async fn integration_complete_against_live_bridge() {
    if std::env::var("CURSOR_API_KEY").is_err() {
        panic!("CURSOR_API_KEY must be set for integration test");
    }

    let provider = CursorProvider::new("composer-2.5".into()).expect("provider");
    let response = provider
        .complete(
            "You are a helpful assistant. Reply briefly.",
            &[ChatMessage::User("Say hello in one word.".into())],
            &[],
        )
        .await
        .expect("live bridge complete");

    assert!(
        !response.text.is_empty() || !response.tool_calls.is_empty(),
        "expected assistant text or tool calls from live bridge"
    );
}
