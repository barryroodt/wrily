use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::cli::Provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCallRequest>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub args_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn provider(&self) -> Provider;
    fn model(&self) -> &str;
    /// One round of completion: send system + messages + available tools, get back text + tool calls + token counts.
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse>;
}

#[derive(Debug, Clone)]
pub enum ChatMessage {
    User(String),
    Assistant {
        text: String,
        tool_calls: Vec<ToolCallRequest>,
    },
    ToolResults(Vec<ToolResult>),
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub json_schema: serde_json::Value,
}

/// Resolve a `Provider` enum + model string into a boxed adapter. Errors if the
/// requested provider's API key env var is missing or the provider is not yet implemented.
pub fn build_adapter(provider: Provider, model: String) -> anyhow::Result<Box<dyn ProviderAdapter>> {
    let _model = model;
    match provider {
        // Phase 1.2-1.5 fill these in
        Provider::Anthropic | Provider::OpenAi | Provider::Gemini | Provider::Cursor => {
            anyhow::bail!("provider {:?} adapter not yet implemented (Phase 1.2-1.5)", provider)
        }
    }
}
