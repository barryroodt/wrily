use crate::expected::Expected;
use thiserror::Error;
use wrily_rig::events::{ExitCode, WrilyEvent};

#[derive(Debug, Error, Clone, PartialEq, Eq)]
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

type ExpectedAssertion =
    fn(&[WrilyEvent], &Expected) -> Result<(), AssertionFailure>;

pub fn run_all(events: &[WrilyEvent], expected: &Expected) -> Vec<AssertionFailure> {
    let checks: &[(&str, ExpectedAssertion)] = &[
        ("assert_exit_matches", assert_exit_matches),
        ("assert_findings_in_range", assert_findings_in_range),
        ("assert_required_phrases", assert_required_phrases),
        ("assert_no_forbidden_phrases", assert_no_forbidden_phrases),
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
    let count = count_findings(events);

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

pub fn assert_required_phrases(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    let texts = assistant_texts(events);

    for phrase in &expected.must_contain_phrases {
        if !texts.iter().any(|text| text.contains(phrase)) {
            return Err(AssertionFailure::new(
                "assert_required_phrases",
                format!("required phrase not found: {phrase:?}"),
            ));
        }
    }

    Ok(())
}

pub fn assert_no_forbidden_phrases(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
    for text in assistant_texts(events) {
        for phrase in &expected.must_not_contain_phrases {
            if text.contains(phrase) {
                return Err(AssertionFailure::new(
                    "assert_no_forbidden_phrases",
                    format!("forbidden phrase found: {phrase:?}"),
                ));
            }
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

pub fn assert_duration(
    events: &[WrilyEvent],
    expected: &Expected,
) -> Result<(), AssertionFailure> {
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
                        format!("unmatched tool_result for role={role:?} turn={turn} tool={tool:?}"),
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

fn terminal_result(events: &[WrilyEvent]) -> Option<&WrilyEvent> {
    events.iter().rev().find(|event| matches!(event, WrilyEvent::Result { .. }))
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

fn count_findings(events: &[WrilyEvent]) -> usize {
    let mut last_count = None;

    for text in assistant_texts(events) {
        for body in extract_json_fence_bodies(text) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(findings) = value.get("findings").and_then(|f| f.as_array()) {
                    last_count = Some(findings.len());
                }
            }
        }
    }

    last_count.unwrap_or(0)
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
