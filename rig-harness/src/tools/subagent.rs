use crate::events::{now_ms, WrilyEvent};
use crate::meter::TokenMeter;
use crate::provider::{ChatMessage, ProviderAdapter};
use crate::tools::ToolRegistry;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

const REVIEWER_MAX_TURNS: u32 = 5;

/// Assemble a reviewer subagent's system prompt per ADR-0003 §3: security
/// constraints, role focus, output-format contract, scoped-diff instruction,
/// optional extra context, and CI context (plus the conventions override).
fn build_reviewer_system_prompt(
    base: &str,
    role: &str,
    diff_scope: &str,
    extra_context: Option<&str>,
) -> String {
    let scope_clause = if diff_scope == "full" || diff_scope.is_empty() {
        "git diff {{DIFF_RANGE}}".to_string()
    } else {
        format!("git diff {{{{DIFF_RANGE}}}} -- {diff_scope}")
    };

    let mut prompt = String::new();
    prompt.push_str(base);
    prompt.push_str(
        "\n\n# Security Constraints\n\
Read-only. git/cat/ls/find only. No tests, builds, linters, gh, or package installs.\n\n",
    );
    prompt.push_str(&format!(
        "# {role} Reviewer\n\
You are reviewing code changes in the \"{role}\" lane. Stay in your lane: style \u{2192} \
conventions reviewer; spec gaps \u{2192} spec-compliance; cross-service contracts \u{2192} \
contracts reviewer. Record cross-lane observations under \"Notes for Other Reviewers\" \
only \u{2014} you cannot message peers directly.\n\n"
    ));
    prompt.push_str(&format!("## Scoped diff\nRun: {scope_clause}\n\n"));
    if let Some(extra) = extra_context.filter(|s| !s.is_empty()) {
        prompt.push_str(extra);
        prompt.push_str("\n\n");
    }
    prompt.push_str(
        "# Reviewer Output Format\n\
Final turn = markdown only, no JSON fence:\n\
## [Reviewer Name] \u{2014} [Focus Area]\n\
### Verdict: Ready to merge / With fixes / Not ready\n\
### Issues\n#### Critical / Important / Minor\n\
- `file:line` \u{2014} Description. **Why it matters:** ...\n\
### Strengths\n### Notes for Other Reviewers\n\n",
    );
    prompt.push_str(
        "# CI context\n\
You are a teammate in an automated Wrily review. A cross-review digest will be \
broadcast later; amend or withdraw findings in your follow-up report.",
    );
    if role.contains("conventions") {
        prompt.push_str(
            "\n\nOVERRIDE: static analysis against AGENTS.md only \u{2014} do NOT execute CI commands.",
        );
    }
    prompt
}

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
        meter: Arc<TokenMeter>,
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
        let cancel = meter.cancellation_token();
        let reviewer_system = build_reviewer_system_prompt(
            &system_template,
            &args.role,
            &args.diff_scope,
            args.extra_context.as_deref(),
        );
        tokio::spawn(async move {
            // The first user turn keeps the "Role: " prefix so the coordinator's
            // scope assignment is explicit in the reviewer's history.
            let mut messages: Vec<ChatMessage> = vec![ChatMessage::User(format!(
                "Role: {role}\nDiff scope: {scope}\nReview using template: {template}",
                role = args.role,
                scope = args.diff_scope,
                template = args.template,
            ))];
            let mut turn: u32 = 0;
            let mut input_tokens: u64 = 0;
            let mut output_tokens: u64 = 0;

            loop {
                if cancel.is_cancelled() {
                    break;
                }

                // Catch panics so a single reviewer cannot take down the run;
                // surface them as `subagent_failed` (invariant #5).
                let attempt = std::panic::AssertUnwindSafe(provider.complete(
                    &reviewer_system,
                    &messages,
                    &[],
                ))
                .catch_unwind()
                .await;

                let resp = match attempt {
                    Ok(Ok(resp)) => resp,
                    Ok(Err(err)) => {
                        let _ = WrilyEvent::SubagentFailed {
                            ts: now_ms(),
                            name: reviewer_name.clone(),
                            reason: err.to_string(),
                        }
                        .emit();
                        break;
                    }
                    Err(_panic) => {
                        let _ = WrilyEvent::SubagentFailed {
                            ts: now_ms(),
                            name: reviewer_name.clone(),
                            reason: "reviewer task panicked".into(),
                        }
                        .emit();
                        break;
                    }
                };

                // Invariant #4: every provider response feeds the shared meter,
                // so reviewer tokens count against the run budget.
                input_tokens += resp.input_tokens;
                output_tokens += resp.output_tokens;
                let tripped = meter
                    .add(
                        resp.input_tokens,
                        resp.output_tokens,
                        resp.cache_read,
                        resp.cache_write,
                    )
                    .is_err();

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

                if tripped || cancel.is_cancelled() {
                    break;
                }

                turn += 1;
                match msg_rx.recv().await {
                    Some(next) => messages.push(ChatMessage::User(next)),
                    None => break,
                }
                if turn >= REVIEWER_MAX_TURNS {
                    break;
                }
            }

            let _ = WrilyEvent::SubagentDone {
                ts: now_ms(),
                name: reviewer_name,
                turns: turn,
                input_tokens,
                output_tokens,
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
