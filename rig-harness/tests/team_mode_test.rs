use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tempfile::TempDir;
use wrily_rig::cancel::{shared_token, spawn_timeout_watchdog};
use wrily_rig::cli::{Mode, Provider, Validated};
use wrily_rig::emitter::TestEmitterGuard;
use wrily_rig::events::{ErrorKind, ExitCode, WrilyEvent};
use wrily_rig::meter::TokenMeter;
use wrily_rig::mode::team::TeamMode;
use wrily_rig::provider::{
    ChatMessage, ProviderAdapter, ProviderResponse, ToolCallRequest, ToolSchema,
};
use wrily_rig::skills::SkillLoader;
use wrily_rig::tools::subagent::ReviewerRoster;
use wrily_rig::tools::ToolRegistry;

struct TeamCoordinatorProvider {
    coordinator: Mutex<Vec<ProviderResponse>>,
    reviewer_text: String,
}

impl TeamCoordinatorProvider {
    fn new(coordinator: Vec<ProviderResponse>, reviewer_text: &str) -> Self {
        Self {
            coordinator: Mutex::new(coordinator),
            reviewer_text: reviewer_text.into(),
        }
    }
}

#[async_trait]
impl ProviderAdapter for TeamCoordinatorProvider {
    fn provider(&self) -> Provider {
        Provider::OpenAi
    }

    fn model(&self) -> &str {
        "gpt-team-test"
    }

    async fn complete(
        &self,
        _system: &str,
        messages: &[ChatMessage],
        _tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        if messages
            .iter()
            .any(|m| matches!(m, ChatMessage::User(text) if text.starts_with("Role: ")))
        {
            return Ok(ProviderResponse {
                text: self.reviewer_text.clone(),
                tool_calls: vec![],
                input_tokens: 1,
                output_tokens: 1,
                cache_read: 0,
                cache_write: 0,
            });
        }

        let mut guard = self.coordinator.lock().unwrap();
        if guard.is_empty() {
            anyhow::bail!("team coordinator stub: no more responses");
        }
        Ok(guard.remove(0))
    }
}

struct PanicReviewerProvider {
    coordinator: Mutex<Vec<ProviderResponse>>,
}

impl PanicReviewerProvider {
    fn new(coordinator: Vec<ProviderResponse>) -> Self {
        Self {
            coordinator: Mutex::new(coordinator),
        }
    }
}

#[async_trait]
impl ProviderAdapter for PanicReviewerProvider {
    fn provider(&self) -> Provider {
        Provider::OpenAi
    }

    fn model(&self) -> &str {
        "gpt-team-collapse"
    }

    async fn complete(
        &self,
        _system: &str,
        messages: &[ChatMessage],
        _tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        if messages
            .iter()
            .any(|m| matches!(m, ChatMessage::User(text) if text.starts_with("Role: ")))
        {
            panic!("reviewer task panic");
        }

        let mut guard = self.coordinator.lock().unwrap();
        Ok(guard.remove(0))
    }
}

fn test_validated(workdir: &TempDir, prompt_file: &std::path::Path) -> Validated {
    Validated {
        mode: Mode::Team,
        model: "gpt-4o".into(),
        provider: Provider::OpenAi,
        workdir: workdir.path().to_path_buf(),
        prompt_file: prompt_file.to_path_buf(),
        max_tokens: 10_000,
        timeout_ms: 60_000,
    }
}

async fn run_team_mode(
    dir: &TempDir,
    provider: Arc<dyn ProviderAdapter>,
    max_tokens: u64,
    timeout_ms: u64,
) -> ExitCode {
    let prompt_path = dir.path().join("prompt.md");
    std::fs::write(&prompt_path, "team review this code").unwrap();

    let mut validated = test_validated(dir, &prompt_path);
    validated.max_tokens = max_tokens;
    validated.timeout_ms = timeout_ms;

    let cancel = shared_token();
    let meter = Arc::new(TokenMeter::new(validated.max_tokens, cancel.clone()));
    let _watchdog = spawn_timeout_watchdog(cancel.clone(), validated.timeout_ms);

    let roster = Arc::new(ReviewerRoster::new());
    let registry = ToolRegistry::team(
        validated.workdir.clone(),
        roster.clone(),
        provider.clone(),
        "reviewer system".into(),
        meter.clone(),
    );

    TeamMode {
        validated,
        meter,
        cancel,
        registry,
        roster,
        skill_loader: SkillLoader::new(dir.path().to_path_buf()),
        provider,
        prompt: "team review this code".into(),
        spawned_reviewers: 0,
    }
    .run()
    .await
}

#[tokio::test]
async fn team_mode_completes_ok_with_subagent_events() {
    let _guard = TestEmitterGuard::install();
    let dir = TempDir::new().unwrap();

    let provider = Arc::new(TeamCoordinatorProvider::new(
        vec![
            ProviderResponse {
                text: String::new(),
                tool_calls: vec![ToolCallRequest {
                    id: "call_spawn".into(),
                    name: "spawn_reviewer".into(),
                    args_json: r#"{"name":"correctness","role":"correctness","template":"correctness","diff_scope":"full"}"#.into(),
                }],
                input_tokens: 5,
                output_tokens: 5,
                cache_read: 0,
                cache_write: 0,
            },
            ProviderResponse {
                text: String::new(),
                tool_calls: vec![ToolCallRequest {
                    id: "call_collect".into(),
                    name: "collect_findings".into(),
                    args_json: r#"{"round":1}"#.into(),
                }],
                input_tokens: 5,
                output_tokens: 5,
                cache_read: 0,
                cache_write: 0,
            },
            ProviderResponse {
                text: "```json\n{\"summary\":\"ok\",\"verdict\":\"ready\",\"findings\":[],\"strengths\":[]}\n```".into(),
                tool_calls: vec![],
                input_tokens: 5,
                output_tokens: 5,
                cache_read: 0,
                cache_write: 0,
            },
        ],
        "round-1 reviewer report",
    ));

    let exit = run_team_mode(&dir, provider, 10_000, 60_000).await;

    assert_eq!(exit, ExitCode::Ok);

    tokio::time::sleep(Duration::from_millis(50)).await;

    let events = _guard.drain_events();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, WrilyEvent::SubagentSpawn { name, .. } if name == "correctness")),
        "expected subagent_spawn, got: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, WrilyEvent::SubagentDone { name, .. } if name == "correctness")),
        "expected subagent_done, got: {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            WrilyEvent::AssistantText { text, role, .. }
                if role == "coordinator" && text.contains("```json")
        )),
        "expected coordinator JSON fence"
    );
}

#[tokio::test]
async fn team_mode_all_reviewers_crash_emits_team_collapse() {
    let _guard = TestEmitterGuard::install();
    let dir = TempDir::new().unwrap();

    let provider = Arc::new(PanicReviewerProvider::new(vec![
        ProviderResponse {
            text: String::new(),
            tool_calls: vec![
                ToolCallRequest {
                    id: "call_spawn_a".into(),
                    name: "spawn_reviewer".into(),
                    args_json: r#"{"name":"broken-a","role":"panic-role","template":"panic-role","diff_scope":"full"}"#.into(),
                },
                ToolCallRequest {
                    id: "call_spawn_b".into(),
                    name: "spawn_reviewer".into(),
                    args_json: r#"{"name":"broken-b","role":"panic-role","template":"panic-role","diff_scope":"full"}"#.into(),
                },
            ],
            input_tokens: 5,
            output_tokens: 5,
            cache_read: 0,
            cache_write: 0,
        },
        ProviderResponse {
            text: String::new(),
            tool_calls: vec![ToolCallRequest {
                id: "call_collect".into(),
                name: "collect_findings".into(),
                args_json: r#"{"round":1}"#.into(),
            }],
            input_tokens: 5,
            output_tokens: 5,
            cache_read: 0,
            cache_write: 0,
        },
    ]));

    let exit = run_team_mode(&dir, provider, 10_000, 60_000).await;

    assert_eq!(exit, ExitCode::Error);

    let events = _guard.drain_events();
    assert!(
        events.iter().any(|e| matches!(
            e,
            WrilyEvent::Error {
                kind: ErrorKind::TeamCollapse,
                ..
            }
        )),
        "expected team_collapse error, got: {events:?}"
    );
}

#[tokio::test]
async fn team_mode_budget_trip_during_reviewer_round() {
    let _guard = TestEmitterGuard::install();
    let dir = TempDir::new().unwrap();

    let provider = Arc::new(TeamCoordinatorProvider::new(
        vec![
            ProviderResponse {
                text: String::new(),
                tool_calls: vec![ToolCallRequest {
                    id: "call_spawn".into(),
                    name: "spawn_reviewer".into(),
                    args_json: r#"{"name":"correctness","role":"correctness","template":"correctness","diff_scope":"full"}"#.into(),
                }],
                input_tokens: 5,
                output_tokens: 5,
                cache_read: 0,
                cache_write: 0,
            },
            ProviderResponse {
                text: String::new(),
                tool_calls: vec![ToolCallRequest {
                    id: "call_collect".into(),
                    name: "collect_findings".into(),
                    args_json: r#"{"round":1}"#.into(),
                }],
                input_tokens: 60,
                output_tokens: 50,
                cache_read: 0,
                cache_write: 0,
            },
        ],
        "slow reviewer report",
    ));

    let cancel = shared_token();
    let meter = Arc::new(TokenMeter::new(100, cancel.clone()));
    let _watchdog = spawn_timeout_watchdog(cancel.clone(), 60_000);

    let prompt_path = dir.path().join("prompt.md");
    std::fs::write(&prompt_path, "team review").unwrap();
    let validated = test_validated(&dir, &prompt_path);

    let roster = Arc::new(ReviewerRoster::new());
    let provider_for_registry = provider.clone();
    let registry = ToolRegistry::team(
        validated.workdir.clone(),
        roster.clone(),
        provider_for_registry,
        "reviewer system".into(),
        meter.clone(),
    );

    let exit = TeamMode {
        validated,
        meter: meter.clone(),
        cancel: cancel.clone(),
        registry,
        roster,
        skill_loader: SkillLoader::new(dir.path().to_path_buf()),
        provider,
        prompt: "team review".into(),
        spawned_reviewers: 0,
    }
    .run()
    .await;

    assert_eq!(exit, ExitCode::Budget);
    assert!(
        cancel.is_cancelled(),
        "cancel should propagate on budget trip"
    );
    assert!(
        _guard
            .drain_events()
            .iter()
            .any(|e| matches!(e, WrilyEvent::BudgetExceeded { .. })),
        "expected budget_exceeded event"
    );
}
