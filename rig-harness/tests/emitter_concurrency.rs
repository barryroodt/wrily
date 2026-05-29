use std::collections::HashSet;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tokio::task::JoinSet;
use wrily_rig::emitter::EventEmitter;
use wrily_rig::events::WrilyEvent;

struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

#[tokio::test]
async fn concurrent_emit_produces_one_thousand_valid_ndjson_lines() {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let emitter = Arc::new(EventEmitter::new(SharedBuffer(Arc::clone(&buf))));

    let mut join_set = JoinSet::new();
    for i in 0..1000 {
        let emitter = Arc::clone(&emitter);
        join_set.spawn(async move {
            emitter
                .emit(&WrilyEvent::AssistantText {
                    ts: i,
                    role: "test".into(),
                    text: format!("line-{i}"),
                })
                .expect("emit");
        });
    }

    while join_set.join_next().await.is_some() {}

    let data = buf.lock().unwrap().clone();
    let text = String::from_utf8(data).expect("utf8");
    let lines: Vec<&str> = text.split('\n').filter(|line| !line.is_empty()).collect();

    assert_eq!(lines.len(), 1000, "expected one NDJSON line per task");

    let mut ts_values = HashSet::new();
    for line in lines {
        let ev: WrilyEvent = serde_json::from_str(line).expect("valid JSON line");
        match ev {
            WrilyEvent::AssistantText { ts, text, .. } => {
                assert_eq!(text, format!("line-{ts}"));
                assert!(ts_values.insert(ts), "duplicate ts {ts}");
            }
            other => panic!("unexpected event variant: {other:?}"),
        }
    }

    assert_eq!(ts_values.len(), 1000);
    for ts in 0..1000 {
        assert!(ts_values.contains(&ts), "missing ts {ts}");
    }
}
