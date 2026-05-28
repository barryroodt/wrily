use rig_core::providers::gemini;
use serde_json::json;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};
use wrily_rig::provider::{ChatMessage, GeminiProvider, ProviderAdapter, ToolSchema};

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

fn provider_for_mock(mock_uri: &str, model: &str) -> GeminiProvider {
    let client = gemini::Client::builder()
        .api_key("test-gemini-key")
        .base_url(mock_uri)
        .build()
        .expect("gemini client");
    GeminiProvider::with_client(model.into(), client)
}

fn text_only_response() -> serde_json::Value {
    json!({
        "responseId": "resp_text",
        "candidates": [{
            "content": {
                "parts": [{ "text": "Hello from Gemini." }],
                "role": "model"
            },
            "finishReason": "STOP"
        }],
        "usageMetadata": {
            "promptTokenCount": 12,
            "candidatesTokenCount": 6,
            "totalTokenCount": 18
        }
    })
}

fn function_call_response() -> serde_json::Value {
    json!({
        "responseId": "resp_tool",
        "candidates": [{
            "content": {
                "parts": [{
                    "functionCall": {
                        "name": "search",
                        "args": { "query": "rig harness" }
                    }
                }],
                "role": "model"
            },
            "finishReason": "STOP"
        }],
        "usageMetadata": {
            "promptTokenCount": 40,
            "candidatesTokenCount": 10,
            "totalTokenCount": 50
        }
    })
}

fn cached_usage_response() -> serde_json::Value {
    json!({
        "responseId": "resp_cache",
        "candidates": [{
            "content": {
                "parts": [{ "text": "cached" }],
                "role": "model"
            },
            "finishReason": "STOP"
        }],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 5,
            "cachedContentTokenCount": 42,
            "totalTokenCount": 105
        }
    })
}

#[tokio::test]
async fn complete_text_only_response_has_empty_tool_calls() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path_regex(r"/v1beta/models/gemini-2\.0-flash:generateContent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(text_only_response()))
        .mount(&mock_server)
        .await;

    let provider = provider_for_mock(mock_server.uri().as_str(), "gemini-2.0-flash");
    let response = provider
        .complete("You are helpful.", &[ChatMessage::User("Hi".into())], &[])
        .await
        .expect("complete");

    assert_eq!(response.text, "Hello from Gemini.");
    assert!(response.tool_calls.is_empty());
    assert_eq!(response.input_tokens, 12);
    assert_eq!(response.output_tokens, 6);
    assert_eq!(response.cache_read, 0);
    assert_eq!(response.cache_write, 0);
}

#[tokio::test]
async fn complete_function_call_response_synthesizes_tool_call_id() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path_regex(r"/v1beta/models/gemini-2\.0-flash:generateContent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(function_call_response()))
        .mount(&mock_server)
        .await;

    let provider = provider_for_mock(mock_server.uri().as_str(), "gemini-2.0-flash");
    let tools = [ToolSchema {
        name: "search".into(),
        description: "Search".into(),
        json_schema: json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        }),
    }];

    let response = provider
        .complete("System", &[ChatMessage::User("Find docs".into())], &tools)
        .await
        .expect("complete");

    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "gem_0_0");
    assert_eq!(response.tool_calls[0].name, "search");
    assert_eq!(
        response.tool_calls[0].args_json,
        r#"{"query":"rig harness"}"#
    );
}

#[tokio::test]
async fn complete_maps_cached_content_token_count_to_cache_read() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path_regex(r"/v1beta/models/gemini-2\.0-flash:generateContent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(cached_usage_response()))
        .mount(&mock_server)
        .await;

    let provider = provider_for_mock(mock_server.uri().as_str(), "gemini-2.0-flash");
    let response = provider
        .complete("Sys", &[ChatMessage::User("q".into())], &[])
        .await
        .expect("complete");

    assert_eq!(response.cache_read, 42);
    assert_eq!(response.cache_write, 0);
}

#[test]
fn new_errors_when_api_key_missing() {
    let _env = EnvVarGuard::set("GEMINI_API_KEY", None);
    let result = GeminiProvider::new("gemini-2.0-flash".into());
    assert!(result.is_err(), "expected missing API key to fail");
    assert_eq!(
        result.err().expect("error").to_string(),
        "GEMINI_API_KEY not set"
    );
}
