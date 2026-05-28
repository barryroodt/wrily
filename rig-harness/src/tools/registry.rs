use super::{
    find_files, git_diff, list_files, read_file, shell, skill_load, subagent, ToolError, ToolOutput,
};
use crate::events::{WrilyEvent, now_ms, truncate_args};
use crate::provider::{ProviderAdapter, ToolSchema};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

struct TeamTools {
    roster: Arc<subagent::ReviewerRoster>,
    provider: Arc<dyn ProviderAdapter>,
    reviewer_system_template: String,
    registry: Weak<ToolRegistry>,
}

/// Native tool dispatcher. Owns workdir + emits `tool_call` / `tool_result` pairs around each call.
pub struct ToolRegistry {
    workdir: PathBuf,
    team: Option<TeamTools>,
}

impl ToolRegistry {
    pub fn new(workdir: PathBuf) -> Self {
        Self {
            workdir,
            team: None,
        }
    }

    /// Team-mode registry: standard tools plus coordinator-only subagent tools.
    pub fn team(
        workdir: PathBuf,
        roster: Arc<subagent::ReviewerRoster>,
        provider: Arc<dyn ProviderAdapter>,
        reviewer_system_template: String,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            workdir,
            team: Some(TeamTools {
                roster,
                provider,
                reviewer_system_template,
                registry: weak.clone(),
            }),
        })
    }

    fn base_schemas() -> Vec<ToolSchema> {
        vec![
            ToolSchema {
                name: "read_file".into(),
                description: "Read a file from the workdir.".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
            },
            ToolSchema {
                name: "list_files".into(),
                description: "List files under a workdir path (max depth 5).".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"max_depth":{"type":"integer"}},"required":["path"]}),
            },
            ToolSchema {
                name: "find_files".into(),
                description: "Glob for files under workdir.".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"}},"required":["pattern"]}),
            },
            ToolSchema {
                name: "git_diff".into(),
                description: "Run git diff in the workdir.".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"range":{"type":"string"},"paths":{"type":"array","items":{"type":"string"}}}}),
            },
            ToolSchema {
                name: "shell".into(),
                description: "Run an allowlisted shell program (git/cat/ls/find).".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"program":{"type":"string"},"args":{"type":"array","items":{"type":"string"}}},"required":["program"]}),
            },
            ToolSchema {
                name: "skill_load".into(),
                description: "Load a skill from workdir .claude/skills (no bundled fallback).".into(),
                json_schema: serde_json::json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}),
            },
        ]
    }

    fn team_schemas() -> Vec<ToolSchema> {
        vec![
            ToolSchema {
                name: "spawn_reviewer".into(),
                description: "Start one reviewer subagent as a concurrent task.".into(),
                json_schema: serde_json::json!({
                    "type":"object",
                    "properties":{
                        "name":{"type":"string"},
                        "role":{"type":"string"},
                        "template":{"type":"string"},
                        "diff_scope":{"type":"string"},
                        "extra_context":{"type":"string"}
                    },
                    "required":["name","role","template","diff_scope"]
                }),
            },
            ToolSchema {
                name: "collect_findings".into(),
                description: "Collect markdown reports from spawned reviewers.".into(),
                json_schema: serde_json::json!({
                    "type":"object",
                    "properties":{"round":{"type":"integer"}},
                    "required":["round"]
                }),
            },
            ToolSchema {
                name: "broadcast_summary".into(),
                description: "Deliver a cross-review digest to all reviewers for refinement.".into(),
                json_schema: serde_json::json!({
                    "type":"object",
                    "properties":{
                        "round":{"type":"integer"},
                        "summary":{"type":"string"}
                    },
                    "required":["round","summary"]
                }),
            },
        ]
    }

    /// JSON schemas to send to the provider as available tools.
    pub fn schemas(&self) -> Vec<ToolSchema> {
        let mut schemas = Self::base_schemas();
        if self.team.is_some() {
            schemas.extend(Self::team_schemas());
        }
        schemas
    }

    /// Dispatch one tool call. Emits `tool_call` and `tool_result` NDJSON events around execution.
    /// On tool error returns the error string in the ToolOutput.content with `error: <msg>` so the agent loop sees a tool_result, not a Rust Err
    /// (invariant #5: tools never abort the run).
    pub async fn dispatch(
        &self,
        role: &str,
        turn: u32,
        name: &str,
        args_json: &str,
    ) -> ToolOutput {
        let args_for_event = truncate_args(args_json, 1024);
        let _ = WrilyEvent::ToolCall {
            ts: now_ms(),
            role: role.into(),
            turn,
            tool: name.into(),
            args: args_for_event,
        }
        .emit();

        let result = self.dispatch_inner(name, args_json).await;
        let (output, error) = match result {
            Ok(o) => (o, None),
            Err(e) => {
                let msg = format!("error: {e}");
                (
                    ToolOutput {
                        bytes: msg.len(),
                        truncated: false,
                        content: msg.clone(),
                    },
                    Some(msg),
                )
            }
        };

        let _ = WrilyEvent::ToolResult {
            ts: now_ms(),
            role: role.into(),
            turn,
            tool: name.into(),
            bytes: output.bytes as u64,
            truncated: output.truncated,
            error,
        }
        .emit();
        output
    }

    fn team_tools(&self) -> Result<&TeamTools, ToolError> {
        self.team
            .as_ref()
            .ok_or_else(|| ToolError::UnknownTool("team tools unavailable in single mode".into()))
    }

    fn tool_output(content: String) -> ToolOutput {
        let bytes = content.len();
        ToolOutput {
            content,
            bytes,
            truncated: false,
        }
    }

    async fn dispatch_inner(&self, name: &str, args_json: &str) -> Result<ToolOutput, ToolError> {
        match name {
            "read_file" => {
                let args: read_file::ReadFileArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                read_file::read_file(&self.workdir, args).await
            }
            "list_files" => {
                let args: list_files::ListFilesArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                list_files::list_files(&self.workdir, args).await
            }
            "find_files" => {
                let args: find_files::FindFilesArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                find_files::find_files(&self.workdir, args).await
            }
            "git_diff" => {
                let args: git_diff::GitDiffArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                git_diff::git_diff(&self.workdir, args).await
            }
            "shell" => {
                let args: shell::ShellArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                shell::shell(&self.workdir, args).await
            }
            "skill_load" => {
                let args: skill_load::SkillLoadArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                skill_load::skill_load(&self.workdir, args).await
            }
            "spawn_reviewer" => {
                let team = self.team_tools()?;
                let args: subagent::SpawnReviewerArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                let registry = team.registry.upgrade().ok_or_else(|| {
                    ToolError::InvalidInput("team registry unavailable".into())
                })?;
                let content = team
                    .roster
                    .spawn_reviewer(
                        args,
                        team.provider.clone(),
                        registry,
                        team.reviewer_system_template.clone(),
                    )
                    .await
                    .map_err(ToolError::InvalidInput)?;
                Ok(Self::tool_output(content))
            }
            "collect_findings" => {
                let team = self.team_tools()?;
                let args: subagent::CollectFindingsArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                let content = team
                    .roster
                    .collect_findings(args)
                    .await
                    .map_err(ToolError::InvalidInput)?;
                Ok(Self::tool_output(content))
            }
            "broadcast_summary" => {
                let team = self.team_tools()?;
                let args: subagent::BroadcastSummaryArgs = serde_json::from_str(args_json)
                    .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                let content = team
                    .roster
                    .broadcast_summary(args)
                    .await
                    .map_err(ToolError::InvalidInput)?;
                Ok(Self::tool_output(content))
            }
            other => Err(ToolError::UnknownTool(other.into())),
        }
    }
}
