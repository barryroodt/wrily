pub mod anthropic;
pub mod cursor;
pub mod gemini;
pub mod openai;

#[allow(dead_code)]
pub fn rig_core_linked() -> bool {
    !rig_core::providers::openai::TEXT_EMBEDDING_3_LARGE.is_empty()
}
