use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};
use wrily_rig::provider::{
    ChatMessage, OpenAiProvider, ProviderAdapter, ToolCallRequest, ToolSchema,
};

/// Process-wide lock serializing env-mutating tests in this binary; env vars are
/// global so the default multi-threaded runner otherwise races
/// `OPENAI_API_KEY`/`OPENAI_BASE_URL` between tests. Held for the guard's lifetime.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct EnvVarGuard {
    vars: Vec<(String, Option<String>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvVarGuard {
    fn set(key: &str, value: Option<&str>) -> Self {
        Self::set_many(&[(key, value)])
    }

    fn set_many(pairs: &[(&str, Option<&str>)]) -> Self {
        let lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let mut vars = Vec::with_capacity(pairs.len());
        for (key, value) in pairs {
            let previous = std::env::var(key).ok();
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            vars.push(((*key).to_string(), previous));
        }
        Self { vars, _lock: lock }
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

fn openai_base_url(mock_server: &MockServer) -> String {
    format!("{}/v1", mock_server.uri())
}

fn single_tool_call_response() -> Value {
    json!({
        "id": "chatcmpl-single",
        "object": "chat.completion",
        "created": 1_700_000_000,
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_weather_1",
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "arguments": "{\"city\":\"Paris\"}"
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 25,
            "total_tokens": 125
        }
    })
}

fn parallel_tool_calls_response() -> Value {
    json!({
        "id": "chatcmpl-parallel",
        "object": "chat.completion",
        "created": 1_700_000_001,
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call_first",
                        "type": "function",
                        "function": {
                            "name": "search",
                            "arguments": "{\"query\":\"rig harness\"}"
                        }
                    },
                    {
                        "id": "call_second",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    }
                ]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {
            "prompt_tokens": 200,
            "completion_tokens": 40,
            "total_tokens": 240
        }
    })
}

fn cached_tokens_response() -> Value {
    json!({
        "id": "chatcmpl-cached",
        "object": "chat.completion",
        "created": 1_700_000_002,
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Cached reply."
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "total_tokens": 1050,
            "prompt_tokens_details": {
                "cached_tokens": 800
            }
        }
    })
}

#[tokio::test]
async fn complete_maps_single_tool_call_and_token_usage() {
    let mock_server = MockServer::start().await;
    let captured = Arc::new(Mutex::new(None::<Value>));
    let captured_for_mock = Arc::clone(&captured);
    let response_body = single_tool_call_response();

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer test-openai-key"))
        .respond_with(move |request: &Request| {
            let body = serde_json::from_slice::<Value>(&request.body)
                .expect("request body should be valid JSON");
            *captured_for_mock.lock().expect("capture lock") = Some(body);
            ResponseTemplate::new(200).set_body_json(response_body.clone())
        })
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let provider = OpenAiProvider::new("gpt-4o".into()).expect("provider");
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

    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "call_weather_1");
    assert_eq!(response.tool_calls[0].name, "get_weather");
    assert_eq!(response.tool_calls[0].args_json, r#"{"city":"Paris"}"#);
    assert_eq!(response.input_tokens, 100);
    assert_eq!(response.output_tokens, 25);
    assert_eq!(response.cache_read, 0);
    assert_eq!(response.cache_write, 0);

    let request_body = captured
        .lock()
        .expect("capture lock")
        .clone()
        .expect("request body captured");

    assert_eq!(request_body["model"], "gpt-4o");
    assert_eq!(
        request_body["messages"][0]["role"], "system",
        "system prompt should be first message"
    );
    let system_content = &request_body["messages"][0]["content"];
    let system_text = system_content
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            system_content
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["text"].as_str())
                .map(str::to_string)
        })
        .expect("system content");
    assert_eq!(system_text, "You are a helpful assistant.");
    assert_eq!(request_body["tools"][0]["function"]["name"], "get_weather");
}

#[tokio::test]
async fn complete_preserves_parallel_tool_call_emission_order() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(parallel_tool_calls_response()))
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let provider = OpenAiProvider::new("gpt-4o".into()).expect("provider");
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
async fn complete_maps_cached_prompt_tokens_to_cache_read() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(cached_tokens_response()))
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let provider = OpenAiProvider::new("gpt-4o".into()).expect("provider");
    let response = provider
        .complete("System", &[ChatMessage::User("hello".into())], &[])
        .await
        .expect("complete");

    assert_eq!(response.text, "Cached reply.");
    assert_eq!(response.input_tokens, 1000);
    assert_eq!(response.output_tokens, 50);
    assert_eq!(response.cache_read, 800);
    assert_eq!(response.cache_write, 0);
}

#[tokio::test]
async fn complete_translates_assistant_tool_calls_and_tool_results_in_history() {
    let mock_server = MockServer::start().await;
    let captured = Arc::new(Mutex::new(None::<Value>));
    let captured_for_mock = Arc::clone(&captured);

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |request: &Request| {
            let body = serde_json::from_slice::<Value>(&request.body)
                .expect("request body should be valid JSON");
            *captured_for_mock.lock().expect("capture lock") = Some(body);
            ResponseTemplate::new(200).set_body_json(single_tool_call_response())
        })
        .mount(&mock_server)
        .await;

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let provider = OpenAiProvider::new("gpt-4o".into()).expect("provider");
    provider
        .complete(
            "System",
            &[
                ChatMessage::User("first".into()),
                ChatMessage::Assistant {
                    text: "calling tool".into(),
                    tool_calls: vec![ToolCallRequest {
                        id: "call_prev".into(),
                        name: "search".into(),
                        args_json: r#"{"query":"rig"}"#.into(),
                    }],
                },
                ChatMessage::ToolResults(vec![wrily_rig::provider::ToolResult {
                    id: "call_prev".into(),
                    content: "prior result".into(),
                    is_error: false,
                }]),
                ChatMessage::User("follow up".into()),
            ],
            &[],
        )
        .await
        .expect("complete");

    let request_body = captured
        .lock()
        .expect("capture lock")
        .clone()
        .expect("request body captured");

    let messages = request_body["messages"].as_array().expect("messages array");

    let assistant = messages
        .iter()
        .find(|message| message["role"] == "assistant")
        .expect("assistant message");
    let assistant_content = &assistant["content"];
    let assistant_text = assistant_content
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            assistant_content
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["text"].as_str())
                .map(str::to_string)
        })
        .expect("assistant content");
    assert_eq!(assistant_text, "calling tool");
    assert_eq!(assistant["tool_calls"][0]["id"], "call_prev");
    assert_eq!(assistant["tool_calls"][0]["type"], "function");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "search");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        r#"{"query":"rig"}"#
    );

    let tool_result = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("tool result message");
    assert_eq!(tool_result["tool_call_id"], "call_prev");
    assert_eq!(tool_result["content"], "prior result");
}

#[test]
fn new_errors_when_api_key_missing() {
    let _env = EnvVarGuard::set("OPENAI_API_KEY", None);
    let result = OpenAiProvider::new("gpt-4o".into());
    assert!(result.is_err(), "expected missing API key to fail");
    assert_eq!(
        result.err().expect("error").to_string(),
        "OPENAI_API_KEY not set"
    );
}
