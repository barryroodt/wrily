use rig_core::{
    message::{AssistantContent, Message, ToolResultContent, UserContent},
    OneOrMany,
};

use super::{ChatMessage, ToolResult};

pub fn chat_messages_to_rig(messages: &[ChatMessage]) -> anyhow::Result<Vec<Message>> {
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

pub fn tool_results_to_user_contents(results: &[ToolResult]) -> anyhow::Result<Vec<UserContent>> {
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
