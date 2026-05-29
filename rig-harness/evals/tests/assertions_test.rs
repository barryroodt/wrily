use wrily_rig::events::{ExitCode, WrilyEvent};
use wrily_rig_evals::{
    assert_duration, assert_exit_matches, assert_findings_in_range, assert_no_forbidden_phrases,
    assert_required_phrases, assert_token_budget, assert_tool_call_pairing, run_all, Expected,
};

fn base_expected() -> Expected {
    Expected {
        fixture: "test".into(),
        exit: "ok".into(),
        min_findings: None,
        max_findings: None,
        must_contain_phrases: Vec::new(),
        must_not_contain_phrases: Vec::new(),
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

    let pass_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "```json\n{\"summary\":\"ok\",\"findings\":[{\"action\":\"new_comment\"}],\"strengths\":[]}\n```".into(),
    }];
    assert!(assert_findings_in_range(&pass_events, &expected).is_ok());

    let fail_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "no json fence here".into(),
    }];
    let failure = assert_findings_in_range(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_findings_in_range");
}

#[test]
fn assert_required_phrases_pass_and_fail() {
    let mut expected = base_expected();
    expected.must_contain_phrases = vec!["looks good".into()];

    let pass_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "Overall this looks good to me.".into(),
    }];
    assert!(assert_required_phrases(&pass_events, &expected).is_ok());

    let fail_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "Needs more work.".into(),
    }];
    let failure = assert_required_phrases(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_required_phrases");
}

#[test]
fn assert_no_forbidden_phrases_pass_and_fail() {
    let mut expected = base_expected();
    expected.must_not_contain_phrases = vec!["TODO".into()];

    let pass_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "Clean review output.".into(),
    }];
    assert!(assert_no_forbidden_phrases(&pass_events, &expected).is_ok());

    let fail_events = vec![WrilyEvent::AssistantText {
        ts: 1,
        role: "assistant".into(),
        text: "Found a TODO in main.rs.".into(),
    }];
    let failure = assert_no_forbidden_phrases(&fail_events, &expected).unwrap_err();
    assert_eq!(failure.rule, "assert_no_forbidden_phrases");
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
    expected.must_contain_phrases = vec!["missing phrase".into()];

    let events = vec![result_event(ExitCode::Budget, 0, 0, 0)];
    let failures = run_all(&events, &expected);
    assert!(failures.len() >= 2);
}
