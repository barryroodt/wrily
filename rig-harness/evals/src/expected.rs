use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expected {
    pub fixture: String,
    pub exit: String, // "ok" | "budget" | "timeout" | "error" | "config"
    pub min_findings: Option<usize>,
    pub max_findings: Option<usize>,
    pub must_contain_phrases: Vec<String>,
    pub must_not_contain_phrases: Vec<String>,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub max_duration_ms: Option<u64>,
}
