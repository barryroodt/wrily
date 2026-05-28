use async_trait::async_trait;
use rig_core::{
    OneOrMany,
    client::CompletionClient,
    completion::{CompletionModel, CompletionRequest, ToolDefinition},
    message::{AssistantContent, Message, ToolResultContent, UserContent},
    providers::anthropic::{
        self,
        completion::{ANTHROPIC_VERSION_LATEST, CompletionModel as AnthropicCompletionModel},
    },
};

use crate::cli::Provider;

use super::{
    ChatMessage, ProviderAdapter, ProviderResponse, ToolCallRequest, ToolResult, ToolSchema,
};

pub struct AnthropicProvider {
    model: String,
    client: anthropic::Client,
}

impl AnthropicProvider {
    pub fn new(model: String) -> anyhow::Result<Self> {
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .map_err(|_| anyhow::anyhow!("ANTHROPIC_API_KEY not set"))?;

        let mut builder = anthropic::Client::builder()
            .api_key(api_key)
            .anthropic_version(ANTHROPIC_VERSION_LATEST)
            .anthropic_beta("prompt-caching-2024-07-31");

        if let Ok(base_url) = std::env::var("ANTHROPIC_API_BASE") {
            builder = builder.base_url(base_url);
        }

        let client = builder
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build Anthropic client: {e}"))?;

        Ok(Self { model, client })
    }

    fn completion_model(&self) -> AnthropicCompletionModel {
        self.client
            .completion_model(&self.model)
            .with_prompt_caching()
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicProvider {
    fn provider(&self) -> Provider {
        Provider::Anthropic
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
        let rig_messages = chat_messages_to_rig(messages)?;
        let chat_history = if rig_messages.is_empty() {
            OneOrMany::one(Message::user(""))
        } else {
            OneOrMany::many(rig_messages)
                .map_err(|_| anyhow::anyhow!("chat history must not be empty"))?
        };

        let request = CompletionRequest {
            model: None,
            preamble: Some(system.to_string()),
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
            .map_err(|e| anyhow::anyhow!("anthropic completion failed: {e}"))?;

        let mut text_parts = Vec::new();
        let mut tool_calls = Vec::new();

        for content in response.choice.iter() {
            match content {
                AssistantContent::Text(text) => text_parts.push(text.text.clone()),
                AssistantContent::ToolCall(tool_call) => {
                    tool_calls.push(ToolCallRequest {
                        id: tool_call.id.clone(),
                        name: tool_call.function.name.clone(),
                        args_json: serde_json::to_string(&tool_call.function.arguments)?,
                    });
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
            cache_write: response.usage.cache_creation_input_tokens,
        })
    }
}

fn chat_messages_to_rig(messages: &[ChatMessage]) -> anyhow::Result<Vec<Message>> {
    let mut out = Vec::with_capacity(messages.len());

    for message in messages {
        match message {
            ChatMessage::User(text) => out.push(Message::user(text)),
            ChatMessage::Assistant { text, tool_calls } => {
                let mut contents = Vec::new();
                if !text.is_empty() {
                    contents.push(AssistantContent::text(text));
                }
                for tool_call in tool_calls {
                    let arguments = serde_json::from_str(&tool_call.args_json)?;
                    contents.push(AssistantContent::tool_call(
                        &tool_call.id,
                        &tool_call.name,
                        arguments,
                    ));
                }
                if contents.is_empty() {
                    contents.push(AssistantContent::text(""));
                }
                out.push(Message::Assistant {
                    id: None,
                    content: OneOrMany::many(contents)
                        .map_err(|_| anyhow::anyhow!("assistant message must have content"))?,
                });
            }
            ChatMessage::ToolResults(results) => {
                let contents = tool_results_to_user_contents(results)?;
                out.push(Message::User {
                    content: OneOrMany::many(contents)
                        .map_err(|_| anyhow::anyhow!("tool results must not be empty"))?,
                });
            }
        }
    }

    Ok(out)
}

fn tool_results_to_user_contents(results: &[ToolResult]) -> anyhow::Result<Vec<UserContent>> {
    results
        .iter()
        .map(|result| {
            Ok(UserContent::ToolResult(rig_core::message::ToolResult {
                id: result.id.clone(),
                call_id: None,
                content: OneOrMany::one(ToolResultContent::text(&result.content)),
            }))
        })
        .collect()
}
