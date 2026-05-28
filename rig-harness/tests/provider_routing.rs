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
fn build_adapter_errors_for_every_provider_variant() {
    for provider in [
        Provider::Anthropic,
        Provider::OpenAi,
        Provider::Gemini,
        Provider::Cursor,
    ] {
        let result = build_adapter(provider.clone(), "test-model".into());
        assert!(result.is_err(), "provider {:?} should be unimplemented", provider);
        let err = result.err().unwrap();
        assert!(
            err.to_string().contains("not yet implemented"),
            "provider {:?}: {err}",
            provider
        );
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
        assert_eq!(
            cli.resolve_provider().unwrap(),
            expected,
            "model {model}"
        );
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
