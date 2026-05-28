use async_trait::async_trait;
use rig_core::{
    client::CompletionClient,
    completion::{self, CompletionModel},
    message::{Message, ToolResultContent, UserContent},
    providers::openai::{self, completion::Message as OpenAiMessage},
    OneOrMany,
};

use crate::cli::Provider;
use crate::provider::{
    ChatMessage, ProviderAdapter, ProviderResponse, ToolCallRequest, ToolResult, ToolSchema,
};

pub struct OpenAiProvider {
    model: String,
    client: openai::Client,
}

impl OpenAiProvider {
    pub fn new(model: String) -> anyhow::Result<Self> {
        let api_key = std::env::var("OPENAI_API_KEY")
            .map_err(|_| anyhow::anyhow!("OPENAI_API_KEY not set"))?;

        let mut builder = openai::Client::builder().api_key(api_key);

        if let Ok(base_url) = std::env::var("OPENAI_BASE_URL") {
            builder = builder.base_url(base_url);
        }

        let client = builder
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build OpenAI client: {e}"))?;

        Ok(Self { model, client })
    }
}

fn chat_messages_to_rig(messages: &[ChatMessage]) -> anyhow::Result<Vec<completion::Message>> {
    let mut out = Vec::new();
    for msg in messages {
        match msg {
            ChatMessage::User(text) => out.push(completion::Message::user(text.clone())),
            ChatMessage::Assistant { text, tool_calls } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(completion::AssistantContent::text(text.clone()));
                }
                for tc in tool_calls {
                    let args = parse_tool_args(&tc.args_json)?;
                    content.push(completion::AssistantContent::tool_call(
                        &tc.id,
                        &tc.name,
                        args,
                    ));
                }
                let content = if content.is_empty() {
                    OneOrMany::one(completion::AssistantContent::text(""))
                } else {
                    OneOrMany::many(content)?
                };
                out.push(completion::Message::Assistant {
                    id: None,
                    content,
                });
            }
            ChatMessage::ToolResults(results) => {
                for result in results {
                    out.push(tool_result_to_rig(result));
                }
            }
        }
    }
    Ok(out)
}

fn parse_tool_args(args_json: &str) -> anyhow::Result<serde_json::Value> {
    if args_json.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    Ok(serde_json::from_str(args_json).unwrap_or_else(|_| {
        serde_json::Value::String(args_json.to_string())
    }))
}

fn tool_result_to_rig(result: &ToolResult) -> Message {
    Message::User {
        content: OneOrMany::one(UserContent::tool_result(
            result.id.clone(),
            OneOrMany::one(ToolResultContent::text(result.content.clone())),
        )),
    }
}

fn tools_to_rig(tools: &[ToolSchema]) -> Vec<completion::ToolDefinition> {
    tools
        .iter()
        .map(|tool| completion::ToolDefinition {
            name: tool.name.clone(),
            description: tool.description.clone(),
            parameters: tool.json_schema.clone(),
        })
        .collect()
}

fn openai_response_to_provider(raw: openai::completion::CompletionResponse) -> anyhow::Result<ProviderResponse> {
    let choice = raw
        .choices
        .first()
        .ok_or_else(|| anyhow::anyhow!("OpenAI response contained no choices"))?;

    let OpenAiMessage::Assistant {
        content,
        tool_calls,
        ..
    } = &choice.message
    else {
        anyhow::bail!("OpenAI response did not contain an assistant message");
    };

    let text = content
        .iter()
        .filter_map(|part| match part {
            openai::completion::AssistantContent::Text { text } if !text.is_empty() => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");

    let tool_calls = tool_calls
        .iter()
        .map(|call| {
            Ok(ToolCallRequest {
                id: call.id.clone(),
                name: call.function.name.clone(),
                args_json: serde_json::to_string(&call.function.arguments)?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let (input_tokens, output_tokens, cache_read) = match raw.usage.as_ref() {
        Some(usage) => {
            let input_tokens = usage.prompt_tokens as u64;
            let output_tokens = usage.total_tokens.saturating_sub(usage.prompt_tokens) as u64;
            let cache_read = usage
                .prompt_tokens_details
                .as_ref()
                .map(|details| details.cached_tokens as u64)
                .unwrap_or(0);
            (input_tokens, output_tokens, cache_read)
        }
        None => (0, 0, 0),
    };

    Ok(ProviderResponse {
        text,
        tool_calls,
        input_tokens,
        output_tokens,
        cache_read,
        cache_write: 0,
    })
}

#[async_trait]
impl ProviderAdapter for OpenAiProvider {
    fn provider(&self) -> Provider {
        Provider::OpenAi
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
        if rig_messages.is_empty() {
            anyhow::bail!("messages must not be empty");
        }

        let request = completion::CompletionRequest {
            model: None,
            preamble: if system.is_empty() {
                None
            } else {
                Some(system.to_string())
            },
            chat_history: OneOrMany::many(rig_messages)?,
            documents: vec![],
            tools: tools_to_rig(tools),
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
        };

        let model = self
            .client
            .clone()
            .completions_api()
            .completion_model(self.model.clone());

        let response = model
            .completion(request)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        openai_response_to_provider(response.raw_response)
    }
}
