use super::{ToolOutput, MAX_TOOL_OUTPUT_BYTES};
use crate::events::TRUNCATE_MARKER;

/// Build a `ToolOutput` from raw content, truncating to MAX_TOOL_OUTPUT_BYTES on a UTF-8 boundary.
pub fn truncated_output(content: String) -> ToolOutput {
    let raw_len = content.len();
    if raw_len <= MAX_TOOL_OUTPUT_BYTES {
        return ToolOutput {
            content,
            bytes: raw_len,
            truncated: false,
        };
    }
    // Find char boundary at or below cap.
    let mut cut = MAX_TOOL_OUTPUT_BYTES;
    while !content.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = content[..cut].to_string();
    out.push_str(TRUNCATE_MARKER);
    ToolOutput {
        content: out,
        bytes: raw_len,
        truncated: true,
    }
}
