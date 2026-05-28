use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tempfile::TempDir;
use wrily_rig::cli::Provider;
use wrily_rig::emitter::TestEmitterGuard;
use wrily_rig::events::WrilyEvent;
use wrily_rig::provider::{ChatMessage, ProviderAdapter, ProviderResponse, ToolSchema};
use wrily_rig::tools::subagent::ReviewerRoster;
use wrily_rig::tools::ToolRegistry;

struct RoleTextProvider {
    /// Maps role string -> list of responses (first round, second round, …).
    responses: Arc<Mutex<std::collections::HashMap<String, Vec<String>>>>,
}

impl RoleTextProvider {
    fn new() -> Self {
        Self {
            responses: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn with_role(self, role: &str, texts: Vec<&str>) -> Self {
        self.responses.lock().unwrap().insert(
            role.to_string(),
            texts.into_iter().map(String::from).collect(),
        );
        self
    }
}

#[async_trait]
impl ProviderAdapter for RoleTextProvider {
    fn provider(&self) -> Provider {
        Provider::OpenAi
    }

    fn model(&self) -> &str {
        "gpt-test"
    }

    async fn complete(
        &self,
        _system: &str,
        messages: &[ChatMessage],
        _tools: &[ToolSchema],
    ) -> anyhow::Result<ProviderResponse> {
        let role = messages
            .iter()
            .find_map(|m| match m {
                ChatMessage::User(text) if text.starts_with("Role: ") => text
                    .lines()
                    .next()
                    .map(|line| line.trim_start_matches("Role: ").to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "unknown".into());

        if role == "panic-role" {
            panic!("reviewer task panic");
        }

        let round_index = messages
            .iter()
            .filter(|m| matches!(m, ChatMessage::User(_)))
            .count()
            .saturating_sub(1);

        let text = self
            .responses
            .lock()
            .unwrap()
            .get(&role)
            .and_then(|v| v.get(round_index))
            .cloned()
            .unwrap_or_else(|| format!("finding for {role} round {round_index}"));

        Ok(ProviderResponse {
            text,
            tool_calls: vec![],
            input_tokens: 1,
            output_tokens: 1,
            cache_read: 0,
            cache_write: 0,
        })
    }
}

#[tokio::test]
async fn spawn_reviewer_adds_to_roster_and_emits_subagent_spawn() {
    let guard = TestEmitterGuard::install();
    let dir = TempDir::new().unwrap();
    let roster = Arc::new(ReviewerRoster::new());
    let provider =
        Arc::new(RoleTextProvider::new().with_role("correctness", vec!["round-1 report"]));
    let registry = ToolRegistry::team(
        dir.path().to_path_buf(),
        roster.clone(),
        provider,
        "reviewer system".into(),
    );

    let out = registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"correctness","role":"correctness","template":"correctness","diff_scope":"full"}"#,
        )
        .await;

    assert!(out.content.contains("reviewer spawned: correctness"));
    assert_eq!(roster.reviewers.lock().await.len(), 1);

    tokio::time::sleep(Duration::from_millis(100)).await;

    let events = guard.drain_events();
    assert!(
        events.iter().any(
            |e| matches!(e, WrilyEvent::SubagentSpawn { name, template, scope, .. }
                if name == "correctness" && template == "correctness" && scope == "full")
        ),
        "expected subagent_spawn event, got: {events:?}"
    );
}

#[tokio::test]
async fn team_registry_exposes_nine_tools_single_mode_exposes_six() {
    let dir = TempDir::new().unwrap();
    let single = ToolRegistry::new(dir.path().to_path_buf());
    assert_eq!(single.schemas().len(), 6);
    assert!(!single.schemas().iter().any(|s| s.name == "spawn_reviewer"));

    let roster = Arc::new(ReviewerRoster::new());
    let provider = Arc::new(RoleTextProvider::new());
    let team = ToolRegistry::team(
        dir.path().to_path_buf(),
        roster,
        provider,
        "template".into(),
    );
    assert_eq!(team.schemas().len(), 9);
    let schemas = team.schemas();
    let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"spawn_reviewer"));
    assert!(names.contains(&"collect_findings"));
    assert!(names.contains(&"broadcast_summary"));
}

#[tokio::test]
async fn broadcast_summary_delivers_to_all_spawned_reviewers() {
    let dir = TempDir::new().unwrap();
    let roster = Arc::new(ReviewerRoster::new());
    let provider = Arc::new(
        RoleTextProvider::new()
            .with_role(
                "correctness",
                vec!["first correctness", "after broadcast correctness"],
            )
            .with_role(
                "spec-compliance",
                vec!["first spec", "after broadcast spec"],
            ),
    );
    let registry = ToolRegistry::team(
        dir.path().to_path_buf(),
        roster.clone(),
        provider,
        "reviewer system".into(),
    );

    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"correctness","role":"correctness","template":"correctness","diff_scope":"full"}"#,
        )
        .await;
    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"spec-compliance","role":"spec-compliance","template":"spec-compliance","diff_scope":"full"}"#,
        )
        .await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let round1 = registry
        .dispatch("coordinator", 2, "collect_findings", r#"{"round":1}"#)
        .await;
    assert!(round1.content.contains("first correctness"));
    assert!(round1.content.contains("first spec"));

    let broadcast = registry
        .dispatch(
            "coordinator",
            3,
            "broadcast_summary",
            r#"{"round":1,"summary":"cross-review digest"}"#,
        )
        .await;
    assert!(broadcast.content.contains("broadcast to 2 reviewers"));

    tokio::time::sleep(Duration::from_millis(150)).await;

    let round2 = registry
        .dispatch("coordinator", 4, "collect_findings", r#"{"round":2}"#)
        .await;
    assert!(round2.content.contains("after broadcast correctness"));
    assert!(round2.content.contains("after broadcast spec"));
}

#[tokio::test]
async fn collect_findings_drains_text_from_finished_reviewers_in_order() {
    let dir = TempDir::new().unwrap();
    let roster = Arc::new(ReviewerRoster::new());
    let provider = Arc::new(
        RoleTextProvider::new()
            .with_role("alpha", vec!["alpha report"])
            .with_role("beta", vec!["beta report"]),
    );
    let registry = ToolRegistry::team(
        dir.path().to_path_buf(),
        roster.clone(),
        provider,
        "reviewer system".into(),
    );

    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"alpha","role":"alpha","template":"alpha","diff_scope":"full"}"#,
        )
        .await;
    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"beta","role":"beta","template":"beta","diff_scope":"full"}"#,
        )
        .await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let out = registry
        .dispatch("coordinator", 2, "collect_findings", r#"{"round":1}"#)
        .await;

    let alpha_pos = out.content.find("alpha report").expect("alpha report");
    let beta_pos = out.content.find("beta report").expect("beta report");
    assert!(
        alpha_pos < beta_pos,
        "expected spawn order (alpha before beta), got: {}",
        out.content
    );
}

#[tokio::test]
async fn partial_failure_one_reviewer_panics_broadcast_and_collect_still_work() {
    let dir = TempDir::new().unwrap();
    let roster = Arc::new(ReviewerRoster::new());
    let provider = Arc::new(
        RoleTextProvider::new()
            .with_role("panic-role", vec!["never emitted"])
            .with_role("healthy", vec!["healthy round 1", "healthy round 2"]),
    );
    let registry = ToolRegistry::team(
        dir.path().to_path_buf(),
        roster.clone(),
        provider,
        "reviewer system".into(),
    );

    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"broken","role":"panic-role","template":"panic-role","diff_scope":"full"}"#,
        )
        .await;
    registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"healthy","role":"healthy","template":"healthy","diff_scope":"full"}"#,
        )
        .await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let round1 = registry
        .dispatch("coordinator", 2, "collect_findings", r#"{"round":1}"#)
        .await;
    assert!(round1.content.contains("healthy round 1"));
    assert!(!round1.content.contains("never emitted"));

    let broadcast = registry
        .dispatch(
            "coordinator",
            3,
            "broadcast_summary",
            r#"{"round":1,"summary":"digest"}"#,
        )
        .await;
    assert!(broadcast.content.contains("broadcast to 2 reviewers"));

    tokio::time::sleep(Duration::from_millis(150)).await;

    let round2 = registry
        .dispatch("coordinator", 4, "collect_findings", r#"{"round":2}"#)
        .await;
    assert!(round2.content.contains("healthy round 2"));
}

#[tokio::test]
async fn single_mode_rejects_subagent_tools() {
    let registry = ToolRegistry::new(std::env::temp_dir());
    let out = registry
        .dispatch(
            "coordinator",
            1,
            "spawn_reviewer",
            r#"{"name":"x","role":"x","template":"x","diff_scope":"full"}"#,
        )
        .await;
    assert!(
        out.content.contains("team tools unavailable"),
        "unexpected: {}",
        out.content
    );
}
