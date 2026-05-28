use crate::events::WrilyEvent;
use std::io::{BufWriter, ErrorKind as IoErrorKind, Write};
use std::sync::Mutex;

pub struct EventEmitter<W: Write + Send> {
    inner: Mutex<BufWriter<W>>,
}

impl<W: Write + Send> EventEmitter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            inner: Mutex::new(BufWriter::new(writer)),
        }
    }

    /// Serialize one NDJSON line and flush immediately so concurrent emitters
    /// never interleave partial lines on the underlying writer.
    pub fn emit(&self, ev: &WrilyEvent) -> anyhow::Result<()> {
        let line = serde_json::to_string(ev)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("EventEmitter mutex poisoned: {e}"))?;
        match writeln!(guard, "{line}").and_then(|_| guard.flush()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == IoErrorKind::BrokenPipe => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn flush(&self) -> anyhow::Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("EventEmitter mutex poisoned: {e}"))?;
        match guard.flush() {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == IoErrorKind::BrokenPipe => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

impl EventEmitter<std::io::Stdout> {
    pub fn stdout() -> Self {
        Self::new(std::io::stdout())
    }
}
