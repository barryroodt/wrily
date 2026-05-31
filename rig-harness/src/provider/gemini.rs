use async_trait::async_trait;
use rig_core::{
    client::CompletionClient,
    completion::{CompletionModel, CompletionRequest, ToolDefinition},
    message::{AssistantContent, Message},
    providers::gemini::{self, completion::CompletionModel as GeminiCompletionModel},
    OneOrMany,
};

use crate::cli::Provider;

use super::retry::{classify_error, with_retry, RetryConfig};
use super::{
    rig_convert::chat_messages_to_rig, ChatMessage, ProviderAdapter, ProviderResponse,
    ToolCallRequest, ToolSchema,
};

pub struct GeminiProvider {
    model: String,
    client: gemini::Client,
}

impl GeminiProvider {
    pub fn new(model: String) -> anyhow::Result<Self> {
        let api_key = std::env::var("GEMINI_API_KEY")
            .map_err(|_| anyhow::anyhow!("GEMINI_API_KEY not set"))?;

        let mut builder = gemini::Client::builder().api_key(api_key);

        if let Ok(base_url) = std::env::var("GEMINI_API_BASE") {
            builder = builder.base_url(base_url);
        }

        let client = builder
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build Gemini client: {e}"))?;

        Ok(Self { model, client })
    }

    /// Build a provider with a pre-configured client (used by wiremock integration tests).
    pub fn with_client(model: String, client: gemini::Client) -> Self {
        Self { model, client }
    }

    fn completion_model(&self) -> GeminiCompletionModel {
        self.client.completion_model(&self.model)
    }
}

#[async_trait]
impl ProviderAdapter for GeminiProvider {
    fn provider(&self) -> Provider {
        Provider::Gemini
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

impl GeminiProvider {
    async fn complete_once(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        let rig_messages = chat_messages_to_rig(messages)?;
        let chat_history = if rig_messages.is_empty() {
            OneOrMany::one(Message::user(""))
        } else {
            OneOrMany::many(rig_messages)
                .map_err(|_| anyhow::anyhow!("chat history must not be empty"))?
        };

        let request = CompletionRequest {
            model: None,
            preamble: if system.is_empty() {
                None
            } else {
                Some(system.to_string())
            },
            chat_history,
            documents: vec![],
            tools: tools
                .iter()
                .map(|tool| ToolDefinition {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.json_schema.clone(),
                })
                .collect(),
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
        };

        let model = self.completion_model();
        let response = model
            .completion(request)
            .await
            .map_err(|e| anyhow::anyhow!("gemini completion failed: {e}"))?;

        let mut text_parts = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_call_idx = 0usize;

        for content in response.choice.iter() {
            match content {
                AssistantContent::Text(text) => text_parts.push(text.text.clone()),
                AssistantContent::ToolCall(tool_call) => {
                    tool_calls.push(ToolCallRequest {
                        id: format!("gem_0_{tool_call_idx}"),
                        name: tool_call.function.name.clone(),
                        args_json: serde_json::to_string(&tool_call.function.arguments)?,
                    });
                    tool_call_idx += 1;
                }
                AssistantContent::Reasoning(reasoning) => {
                    text_parts.push(reasoning.display_text());
                }
                AssistantContent::Image(_) => {}
            }
        }

        Ok(ProviderResponse {
            text: text_parts.join("\n"),
            tool_calls,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_read: response.usage.cached_input_tokens,
            cache_write: 0,
        })
    }
}
