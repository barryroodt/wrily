use wrily_rig::events::{ExitCode, WrilyEvent};
use wrily_rig_evals::{
    assert_duration, assert_exit_matches, assert_findings_in_range, assert_forbidden_message_regex,
    assert_message_regex_matches, assert_required_paths, assert_required_severities,
    assert_single_json_fence, assert_token_budget, assert_tool_call_pairing, run_all, Expected,
};

fn base_expected() -> Expected {
    Expected {
        fixture: "test".into(),
        exit: "ok".into(),
        max_tokens: None,
        min_findings: None,
        max_findings: None,
        must_contain_severity: Vec::new(),
        must_match_path: Vec::new(),
        must_match_message_regex: Vec::new(),
        forbid_match_message_regex: Vec::new(),
        // Default off in unit tests unless a test exercises the fence assertion.
        require_single_json_fence: Some(false),
        max_input_tokens: None,
        max_output_tokens: None,
        max_duration_ms: None,
    }
}

fn result_event(exit: ExitCode, input: u64, output: u64, duration_ms: u64) -> WrilyEvent {
    WrilyEvent::Result {
        ts: 1,
        exit,
        total_input: input,
        total_output: output,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms,
    }
}

fn fence(findings_json: &str) -> WrilyEvent {
    WrilyEvent::AssistantText {
        ts: 1,
        role: "single".into(),
        text: format!(
            "```json\n{{\"summary\":\"s\",\"findings\":{findings_json},\"strengths\":[]}}\n```"
        ),
    }
}

#[test]
fn assert_exit_matches_pass_and_fail() {
    let expected = base_expected();
    let pass_events = vec![result_event(ExitCode::Ok, 0, 0, 0)];
    assert!(assert_exit_matches(&pass_events, &expected).is_ok());

    let fail_events = vec![result_event(ExitCode::Budget, 0, 0, 0)];
    let failure = assert_exit_matches(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_exit_matches");
}

#[test]
fn assert_findings_in_range_pass_and_fail() {
    let mut expected = base_expected();
    expected.min_findings = Some(1);
    expected.max_findings = Some(2);

    let pass_events = vec![fence(
        r#"[{"path":"a.rs","severity":"critical","message":"sql injection"}]"#,
    )];
    assert!(assert_findings_in_range(&pass_events, &expected).is_ok());

    let fail_events = vec![fence("[]")];
    let failure = assert_findings_in_range(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_findings_in_range");
}

#[test]
fn assert_required_severities_pass_and_fail() {
    let mut expected = base_expected();
    expected.must_contain_severity = vec!["critical".into()];

    let pass = vec![fence(
        r#"[{"path":"a.rs","severity":"Critical","message":"x"}]"#,
    )];
    assert!(assert_required_severities(&pass, &expected).is_ok());

    let fail = vec![fence(
        r#"[{"path":"a.rs","severity":"minor","message":"x"}]"#,
    )];
    let failure = assert_required_severities(&fail, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_required_severities");
}

#[test]
fn assert_required_paths_pass_and_fail() {
    let mut expected = base_expected();
    expected.must_match_path = vec!["users_controller.rb".into()];

    let pass = vec![fence(
        r#"[{"path":"app/controllers/users_controller.rb","severity":"critical","message":"x"}]"#,
    )];
    assert!(assert_required_paths(&pass, &expected).is_ok());

    let fail = vec![fence(
        r#"[{"path":"other.rb","severity":"critical","message":"x"}]"#,
    )];
    let failure = assert_required_paths(&fail, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_required_paths");
}

#[test]
fn assert_message_regex_matches_pass_and_fail() {
    let mut expected = base_expected();
    expected.must_match_message_regex = vec!["(?i)injection|sanitiz".into()];

    let pass = vec![fence(
        r#"[{"path":"a.rs","severity":"critical","message":"Possible SQL Injection via interpolation"}]"#,
    )];
    assert!(assert_message_regex_matches(&pass, &expected).is_ok());

    let fail = vec![fence(
        r#"[{"path":"a.rs","severity":"critical","message":"rename this variable"}]"#,
    )];
    let failure = assert_message_regex_matches(&fail, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_message_regex_matches");
}

#[test]
fn assert_message_regex_invalid_pattern_is_reported() {
    let mut expected = base_expected();
    expected.must_match_message_regex = vec!["(unclosed".into()];
    let events = vec![fence(
        r#"[{"path":"a.rs","severity":"critical","message":"x"}]"#,
    )];
    let failure = assert_message_regex_matches(&events, &expected).unwrap_err();
    assert!(failure.detail.contains("invalid regex"));
}

#[test]
fn assert_forbidden_message_regex_pass_and_fail() {
    let mut expected = base_expected();
    expected.forbid_match_message_regex = vec!["(?i)formatting|whitespace".into()];

    let pass = vec![fence(
        r#"[{"path":"a.rs","severity":"critical","message":"sql injection"}]"#,
    )];
    assert!(assert_forbidden_message_regex(&pass, &expected).is_ok());

    let fail = vec![fence(
        r#"[{"path":"a.rs","severity":"minor","message":"fix the Formatting here"}]"#,
    )];
    let failure = assert_forbidden_message_regex(&fail, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_forbidden_message_regex");
}

#[test]
fn assert_single_json_fence_pass_and_fail() {
    let mut expected = base_expected();
    expected.require_single_json_fence = Some(true);

    let pass = vec![fence("[]")];
    assert!(assert_single_json_fence(&pass, &expected).is_ok());

    // Two fences → fail.
    let two = vec![fence("[]"), fence("[]")];
    let failure = assert_single_json_fence(&two, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_single_json_fence");

    // Prose around the fence → fail.
    let prose = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "single".into(),
        text: "Here is my review:\n```json\n{\"findings\":[]}\n```\nLet me know!".into(),
    }];
    let failure = assert_single_json_fence(&prose, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_single_json_fence");

    // No fence → fail.
    let none = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "single".into(),
        text: "no fence at all".into(),
    }];
    let failure = assert_single_json_fence(&none, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_single_json_fence");
}

#[test]
fn assert_single_json_fence_skipped_when_not_required() {
    let expected = base_expected(); // require_single_json_fence = Some(false)
    let events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "single".into(),
        text: "no fence".into(),
    }];
    assert!(assert_single_json_fence(&events, &expected).is_ok());
}

#[test]
fn assert_token_budget_pass_and_fail() {
    let mut expected = base_expected();
    expected.max_input_tokens = Some(100);
    expected.max_output_tokens = Some(50);

    let pass_events = vec![result_event(ExitCode::Ok, 90, 40, 0)];
    assert!(assert_token_budget(&pass_events, &expected).is_ok());

    let fail_events = vec![result_event(ExitCode::Ok, 101, 40, 0)];
    let failure = assert_token_budget(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_token_budget");
}

#[test]
fn assert_duration_pass_and_fail() {
    let mut expected = base_expected();
    expected.max_duration_ms = Some(1_000);

    let pass_events = vec![result_event(ExitCode::Ok, 0, 0, 900)];
    assert!(assert_duration(&pass_events, &expected).is_ok());

    let fail_events = vec![result_event(ExitCode::Ok, 0, 0, 1_001)];
    let failure = assert_duration(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_duration");
}

#[test]
fn assert_tool_call_pairing_pass_and_fail() {
    let pass_events = vec![
        WrilyEvent::ToolCall {
            ts: 1,
            role: "reviewer".into(),
            turn: 1,
            tool: "read_file".into(),
            args: "{}".into(),
        },
        WrilyEvent::ToolResult {
            ts: 2,
            role: "reviewer".into(),
            turn: 1,
            tool: "read_file".into(),
            bytes: 10,
            truncated: false,
            error: None,
        },
    ];
    assert!(assert_tool_call_pairing(&pass_events).is_ok());

    let fail_events = vec![WrilyEvent::ToolCall {
        ts: 1,
        role: "reviewer".into(),
        turn: 1,
        tool: "read_file".into(),
        args: "{}".into(),
    }];
    let failure = assert_tool_call_pairing(&fail_events).unwrap_err();
    assert_eq!(failure.rule, "assert_tool_call_pairing");
    assert!(failure.detail.contains("unpaired tool_call"));
}

#[test]
fn run_all_collects_multiple_failures() {
    let mut expected = base_expected();
    expected.min_findings = Some(1);
    expected.must_contain_severity = vec!["critical".into()];
    expected.require_single_json_fence = Some(true);

    // Budget exit + no findings + no severity + no fence → several failures.
    let events = vec![result_event(ExitCode::Budget, 0, 0, 0)];
    let failures = run_all(&events, &expected);
    assert!(
        failures.len() >= 2,
        "expected multiple failures, got {failures:?}"
    );
}
