use crate::expected::Expected;
use regex::Regex;
use serde_json::Value;
use thiserror::Error;
use wrily_rig::events::{ExitCode, WrilyEvent};

#[derive(Debug, Error, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[error("{rule}: {detail}")]
pub struct AssertionFailure {
    pub rule: String,
    pub detail: String,
}

impl AssertionFailure {
    fn new(rule: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            rule: rule.into(),
            detail: detail.into(),
        }
    }
}

type ExpectedAssertion = fn(&[WrilyEvent], &Expected) -> Result<(), AssertionFailure>;

/// Run every assertion against the events + expectations, collecting all
/// failures (no early return) so a fixture report lists every divergence.
pub fn run_all(events: &[WrilyEvent], expected: &Expected) -> Vec<AssertionFailure> {
    let checks: &[(&str, ExpectedAssertion)] = &[
        ("assert_exit_matches", assert_exit_matches),
        ("assert_findings_in_range", assert_findings_in_range),
        ("assert_required_severities", assert_required_severities),
        ("assert_required_paths", assert_required_paths),
        ("assert_message_regex_matches", assert_message_regex_matches),
        (
            "assert_forbidden_message_regex",
            assert_forbidden_message_regex,
        ),
        ("assert_single_json_fence", assert_single_json_fence),
        ("assert_token_budget", assert_token_budget),
        ("assert_duration", assert_duration),
    ];

    let mut failures = Vec::new();
    for (name, check) in checks {
        if let Err(failure) = check(events, expected) {
            failures.push(AssertionFailure::new(*name, failure.detail));
        }
    }

    if let Err(failure) = assert_tool_call_pairing(events) {
        failures.push(failure);
    }

    failures
}

pub fn assert_exit_matches(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    let want = parse_expected_exit(&expected.exit)?;
    let Some(WrilyEvent::Result { exit, .. }) = terminal_result(events) else {
        return Err(AssertionFailure::new(
            "assert_exit_matches",
            "no terminal result event found",
        ));
    };

    if *exit != want {
        return Err(AssertionFailure::new(
            "assert_exit_matches",
            format!("expected exit {want:?}, got {exit:?}"),
        ));
    }

    Ok(())
}

pub fn assert_findings_in_range(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    let count = findings(events).len();

    if let Some(min) = expected.min_findings {
        if count < min {
            return Err(AssertionFailure::new(
                "assert_findings_in_range",
                format!("findings count {count} below minimum {min}"),
            ));
        }
    }

    if let Some(max) = expected.max_findings {
        if count > max {
            return Err(AssertionFailure::new(
                "assert_findings_in_range",
                format!("findings count {count} above maximum {max}"),
            ));
        }
    }

    Ok(())
}

/// Every required severity appears on at least one finding (case-insensitive).
pub fn assert_required_severities(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if expected.must_contain_severity.is_empty() {
        return Ok(());
    }
    let findings = findings(events);
    let severities: Vec<String> = findings
        .iter()
        .filter_map(|f| f.get("severity").and_then(Value::as_str))
        .map(|s| s.to_lowercase())
        .collect();

    for want in &expected.must_contain_severity {
        let want_lc = want.to_lowercase();
        if !severities.contains(&want_lc) {
            return Err(AssertionFailure::new(
                "assert_required_severities",
                format!("required severity {want:?} not found among findings (got {severities:?})"),
            ));
        }
    }
    Ok(())
}

/// Every `must_match_path` entry appears as a substring of some `finding.path`.
pub fn assert_required_paths(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if expected.must_match_path.is_empty() {
        return Ok(());
    }
    let findings = findings(events);
    let paths: Vec<&str> = findings
        .iter()
        .filter_map(|f| f.get("path").and_then(Value::as_str))
        .collect();

    for want in &expected.must_match_path {
        if !paths.iter().any(|p| p.contains(want.as_str())) {
            return Err(AssertionFailure::new(
                "assert_required_paths",
                format!("required path {want:?} not found among finding paths ({paths:?})"),
            ));
        }
    }
    Ok(())
}

/// Every `must_match_message_regex` matches at least one `finding.message`.
pub fn assert_message_regex_matches(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if expected.must_match_message_regex.is_empty() {
        return Ok(());
    }
    let findings = findings(events);
    let messages: Vec<&str> = findings
        .iter()
        .filter_map(|f| f.get("message").and_then(Value::as_str))
        .collect();

    for pattern in &expected.must_match_message_regex {
        let re = compile(pattern, "assert_message_regex_matches")?;
        if !messages.iter().any(|m| re.is_match(m)) {
            return Err(AssertionFailure::new(
                "assert_message_regex_matches",
                format!("no finding.message matched required regex {pattern:?}"),
            ));
        }
    }
    Ok(())
}

/// No `forbid_match_message_regex` matches any `finding.message`.
pub fn assert_forbidden_message_regex(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if expected.forbid_match_message_regex.is_empty() {
        return Ok(());
    }
    let findings = findings(events);
    let messages: Vec<&str> = findings
        .iter()
        .filter_map(|f| f.get("message").and_then(Value::as_str))
        .collect();

    for pattern in &expected.forbid_match_message_regex {
        let re = compile(pattern, "assert_forbidden_message_regex")?;
        if let Some(hit) = messages.iter().find(|m| re.is_match(m)) {
            return Err(AssertionFailure::new(
                "assert_forbidden_message_regex",
                format!("finding.message matched forbidden regex {pattern:?}: {hit:?}"),
            ));
        }
    }
    Ok(())
}

/// When required (default: `exit == "ok"`), the model output must be exactly one
/// valid ```json fence, with no prose before or after it in the final
/// assistant turn.
pub fn assert_single_json_fence(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if !expected.require_single_json_fence() {
        return Ok(());
    }

    let texts = assistant_texts(events);
    let total_fences: usize = texts
        .iter()
        .map(|t| extract_json_fence_bodies(t).len())
        .sum();

    if total_fences == 0 {
        return Err(AssertionFailure::new(
            "assert_single_json_fence",
            "expected exactly one ```json fence in assistant output, found none",
        ));
    }
    if total_fences > 1 {
        return Err(AssertionFailure::new(
            "assert_single_json_fence",
            format!("expected exactly one ```json fence, found {total_fences}"),
        ));
    }

    // The fence must parse as valid JSON.
    let body = texts
        .iter()
        .flat_map(|t| extract_json_fence_bodies(t))
        .next()
        .unwrap_or_default();
    if serde_json::from_str::<Value>(body).is_err() {
        return Err(AssertionFailure::new(
            "assert_single_json_fence",
            "the ```json fence did not contain valid JSON",
        ));
    }

    // No preamble/trailer: the terminal assistant turn must be exactly the fence.
    if let Some(last) = texts.last() {
        let trimmed = last.trim();
        if !(trimmed.starts_with("```json") && trimmed.ends_with("```")) {
            return Err(AssertionFailure::new(
                "assert_single_json_fence",
                "final assistant turn has prose outside the ```json fence",
            ));
        }
    }

    Ok(())
}

pub fn assert_token_budget(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    if expected.max_input_tokens.is_none() && expected.max_output_tokens.is_none() {
        return Ok(());
    }

    let Some(WrilyEvent::Result {
        total_input,
        total_output,
        ..
    }) = terminal_result(events)
    else {
        return Err(AssertionFailure::new(
            "assert_token_budget",
            "no terminal result event found",
        ));
    };

    if let Some(max_input) = expected.max_input_tokens {
        if *total_input > max_input {
            return Err(AssertionFailure::new(
                "assert_token_budget",
                format!("total_input {total_input} exceeds max_input_tokens {max_input}"),
            ));
        }
    }

    if let Some(max_output) = expected.max_output_tokens {
        if *total_output > max_output {
            return Err(AssertionFailure::new(
                "assert_token_budget",
                format!("total_output {total_output} exceeds max_output_tokens {max_output}"),
            ));
        }
    }

    Ok(())
}

pub fn assert_duration(events: &[WrilyEvent], expected: &Expected) -> Result<(), AssertionFailure> {
    let Some(max_duration_ms) = expected.max_duration_ms else {
        return Ok(());
    };

    let Some(WrilyEvent::Result { duration_ms, .. }) = terminal_result(events) else {
        return Err(AssertionFailure::new(
            "assert_duration",
            "no terminal result event found",
        ));
    };

    if *duration_ms > max_duration_ms {
        return Err(AssertionFailure::new(
            "assert_duration",
            format!("duration_ms {duration_ms} exceeds max_duration_ms {max_duration_ms}"),
        ));
    }

    Ok(())
}

pub fn assert_tool_call_pairing(events: &[WrilyEvent]) -> Result<(), AssertionFailure> {
    let mut pending: Vec<(String, u32, String)> = Vec::new();

    for event in events {
        match event {
            WrilyEvent::ToolCall {
                role, turn, tool, ..
            } => pending.push((role.clone(), *turn, tool.clone())),
            WrilyEvent::ToolResult {
                role, turn, tool, ..
            } => {
                let key = (role.clone(), *turn, tool.clone());
                if let Some(index) = pending.iter().position(|candidate| candidate == &key) {
                    pending.remove(index);
                } else {
                    return Err(AssertionFailure::new(
                        "assert_tool_call_pairing",
                        format!(
                            "unmatched tool_result for role={role:?} turn={turn} tool={tool:?}"
                        ),
                    ));
                }
            }
            _ => {}
        }
    }

    if let Some((role, turn, tool)) = pending.into_iter().next() {
        return Err(AssertionFailure::new(
            "assert_tool_call_pairing",
            format!("unpaired tool_call for role={role:?} turn={turn} tool={tool:?}"),
        ));
    }

    Ok(())
}

fn compile(pattern: &str, rule: &'static str) -> Result<Regex, AssertionFailure> {
    Regex::new(pattern)
        .map_err(|e| AssertionFailure::new(rule, format!("invalid regex {pattern:?}: {e}")))
}

fn terminal_result(events: &[WrilyEvent]) -> Option<&WrilyEvent> {
    events
        .iter()
        .rev()
        .find(|event| matches!(event, WrilyEvent::Result { .. }))
}

fn parse_expected_exit(exit: &str) -> Result<ExitCode, AssertionFailure> {
    match exit {
        "ok" => Ok(ExitCode::Ok),
        "budget" => Ok(ExitCode::Budget),
        "timeout" => Ok(ExitCode::Timeout),
        "error" => Ok(ExitCode::Error),
        "config" => Ok(ExitCode::Config),
        other => Err(AssertionFailure::new(
            "assert_exit_matches",
            format!("unknown expected exit: {other:?}"),
        )),
    }
}

fn assistant_texts(events: &[WrilyEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            WrilyEvent::AssistantText { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// Parse the findings array from the last valid ```json fence in assistant text.
fn findings(events: &[WrilyEvent]) -> Vec<Value> {
    let mut last: Vec<Value> = Vec::new();
    for text in assistant_texts(events) {
        for body in extract_json_fence_bodies(text) {
            if let Ok(value) = serde_json::from_str::<Value>(body) {
                if let Some(arr) = value.get("findings").and_then(|f| f.as_array()) {
                    last = arr.clone();
                }
            }
        }
    }
    last
}

fn extract_json_fence_bodies(text: &str) -> Vec<&str> {
    let mut bodies = Vec::new();
    let mut rest = text;

    while let Some(start) = rest.find("```json") {
        let after_marker = &rest[start + "```json".len()..];
        let content_start = after_marker
            .find('\n')
            .map(|index| index + 1)
            .unwrap_or(after_marker.len());
        let after_newline = &after_marker[content_start..];
        if let Some(end) = after_newline.find("```") {
            bodies.push(after_newline[..end].trim());
            rest = &after_newline[end + "```".len()..];
        } else {
            break;
        }
    }

    bodies
}
