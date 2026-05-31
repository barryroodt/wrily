use serde::{Deserialize, Serialize};

/// Per-fixture expectations. Mirrors the spec's `expected.json` schema
/// (structured finding inspection: severity / path / message-regex), plus a few
/// drift-tracking caps used by the baseline report.
///
/// All assertion fields default to empty/None so a fixture only declares what it
/// cares about.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expected {
    pub fixture: String,
    /// Expected terminal exit: "ok" | "budget" | "timeout" | "error" | "config".
    pub exit: String,

    /// Token cap passed to the binary as `--max-tokens` for this fixture. Lets
    /// the budget-trip fixture trip at a low cap without affecting others.
    #[serde(default)]
    pub max_tokens: Option<u64>,

    #[serde(default)]
    pub min_findings: Option<usize>,
    #[serde(default)]
    pub max_findings: Option<usize>,

    /// Each severity must appear on at least one finding (case-insensitive).
    #[serde(default)]
    pub must_contain_severity: Vec<String>,
    /// Each entry must appear as a substring of at least one `finding.path`.
    #[serde(default)]
    pub must_match_path: Vec<String>,
    /// Each regex must match at least one `finding.message`.
    #[serde(default)]
    pub must_match_message_regex: Vec<String>,
    /// No regex may match any `finding.message`.
    #[serde(default)]
    pub forbid_match_message_regex: Vec<String>,

    /// Whether to require exactly one valid ```json fence with no surrounding
    /// prose. Defaults to `true` when `exit == "ok"` (the coordinator/single
    /// output contract), `false` otherwise (e.g. a budget/timeout abort emits no
    /// fence). Set explicitly to override.
    #[serde(default)]
    pub require_single_json_fence: Option<bool>,

    // --- drift-tracking caps (baseline report; not part of the spec schema) ---
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub max_duration_ms: Option<u64>,
}

impl Expected {
    /// Resolved single-fence requirement (explicit override, else `exit == "ok"`).
    pub fn require_single_json_fence(&self) -> bool {
        self.require_single_json_fence.unwrap_or(self.exit == "ok")
    }
}
