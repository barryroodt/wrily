use crate::events::{now_ms, WrilyEvent};
use crate::provider::{ChatMessage, ProviderAdapter};
use crate::tools::ToolRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Deserialize, Serialize)]
pub struct SpawnReviewerArgs {
    pub name: String,
    pub role: String,     // "correctness" | "conventions" | etc.
    pub template: String, // template skill name
    pub diff_scope: String,
    #[serde(default)]
    pub extra_context: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CollectFindingsArgs {
    pub round: u32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BroadcastSummaryArgs {
    pub round: u32,
    pub summary: String,
}

/// Reviewer state held by the coordinator. spawn_reviewer adds to roster;
/// collect_findings drains assistant_text per reviewer; broadcast_summary feeds
/// summary back to all reviewers as a user-turn for round 2.
pub struct ReviewerRoster {
    pub reviewers: Mutex<Vec<ReviewerHandle>>,
}

pub struct ReviewerHandle {
    pub name: String,
    pub role: String,
    pub messages_tx: tokio::sync::mpsc::UnboundedSender<String>,
    pub findings_rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>,
}

impl ReviewerRoster {
    pub fn new() -> Self {
        Self {
            reviewers: Mutex::new(Vec::new()),
        }
    }

    pub async fn spawn_reviewer(
        &self,
        args: SpawnReviewerArgs,
        provider: Arc<dyn ProviderAdapter>,
        _registry: Arc<ToolRegistry>,
        system_template: String,
    ) -> Result<String, String> {
        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (find_tx, find_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let name = args.name.clone();
        let role = args.role.clone();
        let _ = WrilyEvent::SubagentSpawn {
            ts: now_ms(),
            name: name.clone(),
            template: args.template.clone(),
            scope: args.diff_scope.clone(),
        }
        .emit();

        let reviewer_name = name.clone();
        tokio::spawn(async move {
            // Per-reviewer agent loop — simplified: receive user messages, call provider, push findings.
            let mut messages: Vec<ChatMessage> = Vec::new();
            messages.push(ChatMessage::User(format!(
                "Role: {role}\nDiff scope: {scope}\nReview using template: {template}\n{extra}",
                role = args.role,
                scope = args.diff_scope,
                template = args.template,
                extra = args.extra_context.unwrap_or_default(),
            )));
            let mut turn: u32 = 0;
            loop {
                let resp = match provider.complete(&system_template, &messages, &[]).await {
                    Ok(r) => r,
                    Err(_) => break,
                };
                if !resp.text.is_empty() {
                    let _ = find_tx.send(resp.text.clone());
                    let _ = WrilyEvent::AssistantText {
                        ts: now_ms(),
                        role: reviewer_name.clone(),
                        text: resp.text.clone(),
                    }
                    .emit();
                }
                messages.push(ChatMessage::Assistant {
                    text: resp.text,
                    tool_calls: vec![],
                });
                turn += 1;
                // Wait for next user message or exit.
                match msg_rx.recv().await {
                    Some(next) => messages.push(ChatMessage::User(next)),
                    None => break,
                }
                if turn > 5 {
                    break;
                }
            }
            let _ = WrilyEvent::SubagentDone {
                ts: now_ms(),
                name: reviewer_name,
                turns: turn,
                input_tokens: 0,
                output_tokens: 0,
            }
            .emit();
        });

        self.reviewers.lock().await.push(ReviewerHandle {
            name: name.clone(),
            role,
            messages_tx: msg_tx,
            findings_rx: tokio::sync::Mutex::new(find_rx),
        });
        Ok(format!("reviewer spawned: {name}"))
    }

    pub async fn broadcast_summary(&self, args: BroadcastSummaryArgs) -> Result<String, String> {
        let roster = self.reviewers.lock().await;
        for r in roster.iter() {
            let _ = r
                .messages_tx
                .send(format!("Round {} summary:\n{}", args.round, args.summary));
        }
        Ok(format!("broadcast to {} reviewers", roster.len()))
    }

    pub async fn collect_findings(&self, _args: CollectFindingsArgs) -> Result<String, String> {
        let roster = self.reviewers.lock().await;
        let mut out = String::new();
        for r in roster.iter() {
            let mut rx = r.findings_rx.lock().await;
            while let Ok(text) = rx.try_recv() {
                out.push_str(&format!("\n## {} ({})\n{text}\n", r.name, r.role));
            }
        }
        Ok(out)
    }
}

impl Default for ReviewerRoster {
    fn default() -> Self {
        Self::new()
    }
}
