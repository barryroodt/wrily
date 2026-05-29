use crate::events::WrilyEvent;
use std::cell::RefCell;
use std::io::{BufWriter, ErrorKind as IoErrorKind, Write};
use std::sync::{Arc, Mutex, OnceLock};

static STDOUT_EMITTER: OnceLock<EventEmitter<std::io::Stdout>> = OnceLock::new();

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

    pub fn global() -> &'static Self {
        STDOUT_EMITTER.get_or_init(Self::stdout)
    }
}

struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

type TestEmitterSlot = (EventEmitter<SharedBuffer>, Arc<Mutex<Vec<u8>>>);

thread_local! {
    static TEST_EMITTER: RefCell<Option<TestEmitterSlot>> = const { RefCell::new(None) };
}

/// Redirect [`WrilyEvent::emit`] to an in-memory NDJSON buffer for the current thread.
pub struct TestEmitterGuard {
    buffer: Arc<Mutex<Vec<u8>>>,
}

impl TestEmitterGuard {
    pub fn install() -> Self {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let emitter = EventEmitter::new(SharedBuffer(Arc::clone(&buffer)));
        TEST_EMITTER.with(|slot| *slot.borrow_mut() = Some((emitter, Arc::clone(&buffer))));
        Self { buffer }
    }

    pub fn drain_events(&self) -> Vec<WrilyEvent> {
        let data = self.buffer.lock().unwrap().clone();
        let text = String::from_utf8(data).unwrap_or_default();
        text.lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("valid NDJSON event"))
            .collect()
    }
}

impl Drop for TestEmitterGuard {
    fn drop(&mut self) {
        TEST_EMITTER.with(|slot| *slot.borrow_mut() = None);
    }
}

pub(crate) fn emit_active(ev: &WrilyEvent) -> anyhow::Result<()> {
    TEST_EMITTER.with(|slot| {
        if let Some((ref emitter, _)) = *slot.borrow() {
            emitter.emit(ev)
        } else {
            EventEmitter::global().emit(ev)
        }
    })
}
