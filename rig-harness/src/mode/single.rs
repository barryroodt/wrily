use crate::cli::Validated;
use crate::events::{now_ms, ExitCode, WrilyEvent};
use crate::meter::TokenMeter;
use crate::provider::{build_adapter, ChatMessage, ProviderAdapter, ToolResult};
use crate::skills::SkillLoader;
use crate::tools::ToolRegistry;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct SingleMode {
    pub validated: Validated,
    pub meter: Arc<TokenMeter>,
    pub cancel: CancellationToken,
    pub registry: ToolRegistry,
    pub skill_loader: SkillLoader,
    pub provider: Box<dyn ProviderAdapter>,
    pub prompt: String,
}

impl SingleMode {
    /// Run the single-mode loop. Always emits a terminal `result` event.
    /// Returns the ExitCode to translate to process exit.
    pub async fn run(self) -> ExitCode {
        // Skills are pre-injected into the system prompt.
        let system_prefix = self.skill_loader.inject_core_skills();
        let system = format!("{system_prefix}\nYou are wrily-rig running a code review task. Use the available tools.");

        let tools = self.registry.schemas();
        let mut messages: Vec<ChatMessage> = vec![ChatMessage::User(self.prompt.clone())];
        let mut turn: u32 = 0;
        const MAX_TURNS: u32 = 20;

        loop {
            if self.cancel.is_cancelled() {
                return if self.meter.tripped() {
                    ExitCode::Budget
                } else {
                    ExitCode::Timeout
                };
            }
            if turn >= MAX_TURNS {
                break;
            }

            let resp_fut = self.provider.complete(&system, &messages, &tools);
            let resp = tokio::select! {
                r = resp_fut => r,
                _ = self.cancel.cancelled() => {
                    return if self.meter.tripped() { ExitCode::Budget } else { ExitCode::Timeout };
                }
            };
            let resp = match resp {
                Ok(r) => r,
                Err(err) => {
                    let _ = WrilyEvent::Error {
                        ts: now_ms(),
                        kind: crate::events::ErrorKind::Provider,
                        message: err.to_string(),
                    }
                    .emit();
                    return ExitCode::Error;
                }
            };

            // Meter check
            if let Err(_be) = self.meter.add(
                resp.input_tokens,
                resp.output_tokens,
                resp.cache_read,
                resp.cache_write,
            ) {
                return ExitCode::Budget;
            }

            let _ = WrilyEvent::AgentTurn {
                ts: now_ms(),
                role: "single".into(),
                turn,
                input_tokens: resp.input_tokens,
                output_tokens: resp.output_tokens,
                cache_read: resp.cache_read,
                cache_write: resp.cache_write,
            }
            .emit();

            if !resp.text.is_empty() {
                let _ = WrilyEvent::AssistantText {
                    ts: now_ms(),
                    role: "single".into(),
                    text: resp.text.clone(),
                }
                .emit();
            }

            if resp.tool_calls.is_empty() {
                // No tool calls → loop done.
                break;
            }

            // Dispatch tools in order.
            let mut tool_results = Vec::with_capacity(resp.tool_calls.len());
            for call in &resp.tool_calls {
                let out = self
                    .registry
                    .dispatch("single", turn, &call.name, &call.args_json)
                    .await;
                tool_results.push(ToolResult {
                    id: call.id.clone(),
                    content: out.content,
                    is_error: false,
                });
            }

            // Append assistant message + tool results to conversation.
            messages.push(ChatMessage::Assistant {
                text: resp.text,
                tool_calls: resp.tool_calls,
            });
            messages.push(ChatMessage::ToolResults(tool_results));
            turn += 1;
        }

        ExitCode::Ok
    }
}

/// Public entry point used by main.rs.
pub async fn run_single(validated: Validated) -> ExitCode {
    use crate::cancel::shared_token;
    use crate::cancel::spawn_timeout_watchdog;

    let cancel = shared_token();
    let meter = Arc::new(TokenMeter::new(validated.max_tokens, cancel.clone()));
    let _watchdog = spawn_timeout_watchdog(cancel.clone(), validated.timeout_ms);

    let provider = match build_adapter(validated.provider.clone(), validated.model.clone()) {
        Ok(p) => p,
        Err(err) => {
            let _ = WrilyEvent::Error {
                ts: now_ms(),
                kind: crate::events::ErrorKind::Config,
                message: err.to_string(),
            }
            .emit();
            return ExitCode::Config;
        }
    };

    let prompt = match std::fs::read_to_string(&validated.prompt_file) {
        Ok(p) => p,
        Err(err) => {
            let _ = WrilyEvent::Error {
                ts: now_ms(),
                kind: crate::events::ErrorKind::Config,
                message: format!("prompt file: {err}"),
            }
            .emit();
            return ExitCode::Config;
        }
    };

    let registry = ToolRegistry::new(validated.workdir.clone());
    let skill_loader = SkillLoader::new(validated.workdir.clone());

    SingleMode {
        validated,
        meter,
        cancel,
        registry,
        skill_loader,
        provider,
        prompt,
    }
    .run()
    .await
}
