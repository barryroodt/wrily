use std::fs;
use std::path::{Path, PathBuf};

use wrily_rig::cli::{Cli, ConfigError, Mode, Provider};
use wrily_rig::provider::build_adapter;

fn temp_workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wrily-rig-provider-routing-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp workdir");
    dir
}

fn write_prompt_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, contents).expect("write prompt file");
    path
}

fn base_cli(workdir: &Path, prompt_file: &Path) -> Cli {
    Cli {
        mode: Mode::Single,
        model: "claude-sonnet-4".into(),
        provider: None,
        workdir: workdir.to_path_buf(),
        prompt_file: prompt_file.to_path_buf(),
        max_tokens: 8192,
        timeout_ms: 60_000,
    }
}

fn cli_for_model(workdir: &Path, prompt_file: &Path, model: &str) -> Cli {
    Cli {
        model: model.into(),
        ..base_cli(workdir, prompt_file)
    }
}

#[test]
fn build_adapter_cursor_requires_api_key() {
    let _env = EnvVarGuard::set("CURSOR_API_KEY", None);
    let result = build_adapter(Provider::Cursor, "composer-2.5".into());
    assert!(result.is_err());
    assert!(result
        .err()
        .expect("error")
        .to_string()
        .contains("CURSOR_API_KEY not set"));
}

#[test]
fn build_adapter_anthropic_requires_api_key() {
    let _env = EnvVarGuard::set("ANTHROPIC_API_KEY", None);
    let result = build_adapter(Provider::Anthropic, "claude-sonnet-4".into());
    assert!(result.is_err());
    assert!(result
        .err()
        .expect("error")
        .to_string()
        .contains("ANTHROPIC_API_KEY not set"));
}

#[test]
fn build_adapter_openai_requires_api_key() {
    let _env = EnvVarGuard::set("OPENAI_API_KEY", None);
    let result = build_adapter(Provider::OpenAi, "gpt-4o".into());
    assert!(result.is_err());
    assert!(result
        .err()
        .expect("error")
        .to_string()
        .contains("OPENAI_API_KEY not set"));
}

#[test]
fn build_adapter_gemini_requires_api_key() {
    let _env = EnvVarGuard::set("GEMINI_API_KEY", None);
    let result = build_adapter(Provider::Gemini, "gemini-2.0-flash".into());
    assert!(result.is_err());
    assert!(result
        .err()
        .expect("error")
        .to_string()
        .contains("GEMINI_API_KEY not set"));
}

/// Process-wide lock serializing env-mutating tests in this binary; env vars are
/// global so the default multi-threaded runner otherwise races provider API-key
/// vars between the `build_adapter_*_requires_api_key` tests. Held for the
/// guard's lifetime.
fn env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

struct EnvVarGuard {
    key: String,
    previous: Option<String>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvVarGuard {
    fn set(key: &str, value: Option<&str>) -> Self {
        let lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let previous = std::env::var(key).ok();
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        Self {
            key: key.to_string(),
            previous,
            _lock: lock,
        }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(&self.key, value),
            None => std::env::remove_var(&self.key),
        }
    }
}

#[test]
fn infer_provider_from_model_table() {
    let workdir = temp_workdir("model-table");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");

    let cases = [
        ("claude-3-5-sonnet-latest", Provider::Anthropic),
        ("claude-haiku-4-5-20251001", Provider::Anthropic),
        ("gpt-4o", Provider::OpenAi),
        ("gpt-4o-mini", Provider::OpenAi),
        ("o1", Provider::OpenAi),
        ("o3-mini", Provider::OpenAi),
        ("gemini-2.0-flash", Provider::Gemini),
        ("gemini-1.5-pro", Provider::Gemini),
        ("cursor-composer-2.5", Provider::Cursor),
        ("cursor-composer-2.5-fast", Provider::Cursor),
        ("composer-2.5", Provider::Cursor),
    ];

    for (model, expected) in cases {
        let cli = cli_for_model(&workdir, &prompt, model);
        assert_eq!(cli.resolve_provider().unwrap(), expected, "model {model}");
    }
}

#[test]
fn infer_provider_rejects_ambiguous_models() {
    let workdir = temp_workdir("ambiguous");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");

    for model in ["o", "model-x", "gpt", "claude"] {
        let cli = cli_for_model(&workdir, &prompt, model);
        assert_eq!(
            cli.resolve_provider(),
            Err(ConfigError::AmbiguousProvider {
                model: model.into(),
            }),
            "model {model}"
        );
    }
}
