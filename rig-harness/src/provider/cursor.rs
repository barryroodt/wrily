use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::cli::Provider;
use crate::provider::retry::{classify_error, with_retry, RetryConfig};
use crate::provider::{
    ChatMessage, ProviderAdapter, ProviderResponse, ToolCallRequest, ToolResult, ToolSchema,
};

const DEFAULT_API_BASE: &str = "https://api.cursor.com";
const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:8765";

pub struct CursorProvider {
    model: String,
    api_key: String,
    base: String,
    bridge: String,
    client: reqwest::Client,
}

impl CursorProvider {
    pub fn new(model: String) -> anyhow::Result<Self> {
        let model = normalize_model(&model)?;
        let api_key = std::env::var("CURSOR_API_KEY")
            .map_err(|_| anyhow::anyhow!("CURSOR_API_KEY not set"))?;
        let base = std::env::var("CURSOR_API_BASE").unwrap_or_else(|_| DEFAULT_API_BASE.into());
        let bridge =
            std::env::var("CURSOR_BRIDGE_URL").unwrap_or_else(|_| DEFAULT_BRIDGE_URL.into());
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build HTTP client: {e}"))?;

        Ok(Self {
            model,
            api_key,
            base,
            bridge,
            client,
        })
    }

    #[allow(dead_code)]
    pub fn api_base(&self) -> &str {
        &self.base
    }
}

/// Map CLI/config model aliases to canonical Composer IDs (ADR-0001 §1).
pub fn normalize_model(model: &str) -> anyhow::Result<String> {
    match model {
        "composer-2.5" | "cursor-composer-2.5" => Ok("composer-2.5".into()),
        "composer-2.5-fast" | "cursor-composer-2.5-fast" => Ok("composer-2.5-fast".into()),
        other => anyhow::bail!(
            "unsupported Cursor model {other:?}; expected composer-2.5, composer-2.5-fast, \
             or cursor-composer-* aliases (use --provider cursor, not openai)"
        ),
    }
}

#[derive(Serialize)]
struct TurnRequest<'a> {
    model: &'a str,
    system: &'a str,
    messages: Vec<Value>,
    tools: Vec<Value>,
    cwd: String,
}

fn chat_messages_to_bridge(messages: &[ChatMessage]) -> anyhow::Result<Vec<Value>> {
    let mut out = Vec::new();
    for msg in messages {
        match msg {
            ChatMessage::User(text) => {
                out.push(json!({
                    "role": "user",
                    "content": text,
                }));
            }
            ChatMessage::Assistant { text, tool_calls } => {
                let tool_calls_json: Vec<Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        let input = parse_tool_args(&tc.args_json)?;
                        Ok(json!({
                            "id": tc.id,
                            "name": tc.name,
                            "input": input,
                        }))
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?;
                out.push(json!({
                    "role": "assistant",
                    "content": text,
                    "tool_calls": tool_calls_json,
                }));
            }
            ChatMessage::ToolResults(results) => {
                for result in results {
                    out.push(tool_result_to_bridge(result));
                }
            }
        }
    }
    Ok(out)
}

fn parse_tool_args(args_json: &str) -> anyhow::Result<Value> {
    if args_json.trim().is_empty() {
        return Ok(json!({}));
    }
    Ok(serde_json::from_str(args_json).unwrap_or_else(|_| Value::String(args_json.to_string())))
}

fn tool_result_to_bridge(result: &ToolResult) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": result.id,
        "content": result.content,
        "is_error": result.is_error,
    })
}

fn tools_to_bridge(tools: &[ToolSchema]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "json_schema": tool.json_schema,
            })
        })
        .collect()
}

fn workdir_for_request() -> String {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| ".".into())
}

fn usage_from_event(data: &Value) -> (u64, u64, u64, u64) {
    let usage = data.get("usage").unwrap_or(data);
    (
        usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        usage
            .get("cache_read_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        usage
            .get("cache_write_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    )
}

fn args_to_json_string(args: &Value) -> anyhow::Result<String> {
    match args {
        Value::String(s) => Ok(s.clone()),
        other => Ok(serde_json::to_string(other)?),
    }
}

struct StreamAccumulator {
    text: String,
    tool_calls: Vec<ToolCallRequest>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
}

impl StreamAccumulator {
    fn new() -> Self {
        Self {
            text: String::new(),
            tool_calls: Vec::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
        }
    }

    fn into_response(self) -> ProviderResponse {
        ProviderResponse {
            text: self.text,
            tool_calls: self.tool_calls,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
        }
    }
}

fn process_stream_event(
    event_name: &str,
    data: &str,
    acc: &mut StreamAccumulator,
) -> anyhow::Result<()> {
    let payload: Value = if data.is_empty() {
        json!({})
    } else {
        serde_json::from_str(data).map_err(|e| anyhow::anyhow!("invalid SSE JSON: {e}"))?
    };

    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(event_name);

    match event_type {
        "assistant" => {
            if let Some(delta) = payload.get("text").and_then(Value::as_str) {
                acc.text.push_str(delta);
            } else if let Some(full) = payload.get("content").and_then(Value::as_str) {
                acc.text.push_str(full);
            }
        }
        "tool_call" | "tool_use" => {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("running");
            if status == "completed" {
                return Ok(());
            }
            let id = payload
                .get("callId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args = payload
                .get("args")
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(json!({}));
            if !id.is_empty() && !name.is_empty() {
                acc.tool_calls.push(ToolCallRequest {
                    id,
                    name,
                    args_json: args_to_json_string(&args)?,
                });
            }
        }
        "interaction_update" | "turn-ended" => {
            let (in_t, out_t, cr, cw) = usage_from_event(&payload);
            acc.input_tokens = in_t;
            acc.output_tokens = out_t;
            acc.cache_read = cr;
            acc.cache_write = cw;
        }
        "error" => {
            let message = payload
                .get("message")
                .or_else(|| payload.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("cursor bridge error");
            anyhow::bail!("{message}");
        }
        "thinking" | "thinking-delta" => {}
        _ if event_name == "turn-ended" || event_name == "interaction_update" => {
            let (in_t, out_t, cr, cw) = usage_from_event(&payload);
            acc.input_tokens = in_t;
            acc.output_tokens = out_t;
            acc.cache_read = cr;
            acc.cache_write = cw;
        }
        _ => {}
    }

    Ok(())
}

async fn consume_sse(response: reqwest::Response) -> anyhow::Result<ProviderResponse> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("cursor bridge returned {status}: {body}");
    }

    let mut acc = StreamAccumulator::new();
    let mut stream = response.bytes_stream().eventsource();

    while let Some(item) = stream.next().await {
        let event = item.map_err(|e| anyhow::anyhow!("SSE stream error: {e}"))?;
        process_stream_event(&event.event, &event.data, &mut acc)?;
    }

    Ok(acc.into_response())
}

#[async_trait]
impl ProviderAdapter for CursorProvider {
    fn provider(&self) -> Provider {
        Provider::Cursor
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        let config = RetryConfig::default();
        with_retry(&config, classify_error, || {
            Box::pin(self.complete_once(system, messages, tools))
        })
        .await
    }
}

impl CursorProvider {
    async fn complete_once(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        let bridge_messages = chat_messages_to_bridge(messages)?;
        let bridge_tools = tools_to_bridge(tools);
        let cwd = workdir_for_request();

        let body = TurnRequest {
            model: &self.model,
            system,
            messages: bridge_messages,
            tools: bridge_tools,
            cwd,
        };

        let url = format!("{}/v1/turns", self.bridge.trim_end_matches('/'));
        let response = self
            .client
            .post(&url)
            .basic_auth(&self.api_key, Some(""))
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("cursor bridge request failed: {e}"))?;

        // We own the HTTP layer here, so classify status precisely and surface
        // `Retry-After` to the retry policy via the embedded `retry-after=` hint.
        let status = response.status();
        if !status.is_success() {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let hint = retry_after
                .map(|s| format!(" retry-after={s}"))
                .unwrap_or_default();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("cursor bridge returned {status}:{hint} {body}");
        }

        consume_sse(response).await
    }
}
