use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
#[error("budget exceeded")]
pub struct BudgetExceededError;

#[allow(dead_code)]
pub fn placeholder_meter() -> bool {
    true
}
