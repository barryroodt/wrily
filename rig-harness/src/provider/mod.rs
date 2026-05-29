use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::cli::Provider;

pub mod anthropic;
pub mod cursor;
pub mod gemini;
pub mod openai;
mod rig_convert;

pub use anthropic::AnthropicProvider;
pub use cursor::CursorProvider;
pub use gemini::GeminiProvider;
pub use openai::OpenAiProvider;

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
pub fn build_adapter(
    provider: Provider,
    model: String,
) -> anyhow::Result<Box<dyn ProviderAdapter>> {
    match provider {
        Provider::Anthropic => Ok(Box::new(anthropic::AnthropicProvider::new(model)?)),
        Provider::OpenAi => Ok(Box::new(openai::OpenAiProvider::new(model)?)),
        Provider::Gemini => Ok(Box::new(GeminiProvider::new(model)?)),
        Provider::Cursor => Ok(Box::new(cursor::CursorProvider::new(model)?)),
    }
}
