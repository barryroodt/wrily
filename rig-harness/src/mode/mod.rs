use crate::events::ExitCode;
use crate::meter::MeterSnapshot;

pub mod single;
pub mod team;

/// Outcome of a single or team mode run, including token totals for the terminal result.
pub struct ModeRunOutcome {
    pub exit: ExitCode,
    pub meter: MeterSnapshot,
}
