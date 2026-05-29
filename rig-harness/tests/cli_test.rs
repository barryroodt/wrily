use clap::Parser;
use std::fs;
use std::path::{Path, PathBuf};
use wrily_rig::cli::{Cli, ConfigError, Mode, Provider};

fn temp_workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wrily-rig-cli-test-{name}"));
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

#[test]
fn provider_inference_anthropic() {
    let workdir = temp_workdir("anthropic");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "claude-sonnet-4".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(cli.resolve_provider().unwrap(), Provider::Anthropic);
}

#[test]
fn provider_inference_openai_gpt() {
    let workdir = temp_workdir("openai-gpt");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "gpt-4o".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(cli.resolve_provider().unwrap(), Provider::OpenAi);
}

#[test]
fn provider_inference_openai_o_series() {
    let workdir = temp_workdir("openai-o");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "o3-mini".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(cli.resolve_provider().unwrap(), Provider::OpenAi);
}

#[test]
fn provider_inference_gemini() {
    let workdir = temp_workdir("gemini");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "gemini-2.0-flash".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(cli.resolve_provider().unwrap(), Provider::Gemini);
}

#[test]
fn provider_inference_cursor_prefixes() {
    let workdir = temp_workdir("cursor");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");

    for model in ["composer-2.5-fast", "cursor-composer-2.5-fast"] {
        let cli = Cli {
            model: model.into(),
            ..base_cli(&workdir, &prompt)
        };
        assert_eq!(
            cli.resolve_provider().unwrap(),
            Provider::Cursor,
            "model {model}"
        );
    }
}

#[test]
fn provider_inference_rejects_non_o_series() {
    let workdir = temp_workdir("non-o-series");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "olmo-7b".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(
        cli.resolve_provider(),
        Err(ConfigError::AmbiguousProvider {
            model: "olmo-7b".into(),
        })
    );
}

#[test]
fn provider_inference_drops_bare_cursor_prefix() {
    let workdir = temp_workdir("bare-cursor");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "cursor-fast".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(
        cli.resolve_provider(),
        Err(ConfigError::AmbiguousProvider {
            model: "cursor-fast".into(),
        })
    );
}

#[test]
fn resolve_provider_rejects_mismatch() {
    let workdir = temp_workdir("mismatch");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "composer-2.5-fast".into(),
        provider: Some(Provider::OpenAi),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(
        cli.resolve_provider(),
        Err(ConfigError::ProviderModelMismatch {
            provider: Provider::OpenAi,
            model: "composer-2.5-fast".into(),
        })
    );
}

#[test]
fn parse_and_validate_canonicalises_workdir() {
    let dir = temp_workdir("canonical");
    let prompt = write_prompt_file(&dir, "prompt.txt", "hello");
    let sub = dir.join("sub");
    fs::create_dir_all(&sub).expect("create subdir");
    let workdir_arg = sub.join("..");
    let canonical = dir.canonicalize().expect("canonicalize dir");

    let validated = Cli::parse_and_validate_from([
        "wrily-rig",
        "--mode",
        "single",
        "--model",
        "claude-sonnet-4",
        "--workdir",
        workdir_arg.to_str().unwrap(),
        "--prompt-file",
        prompt.to_str().unwrap(),
        "--max-tokens",
        "8192",
        "--timeout-ms",
        "60000",
    ])
    .expect("parse_and_validate");

    assert_eq!(validated.workdir, canonical);
}

#[test]
fn parse_and_validate_returns_resolved_provider() {
    let workdir = temp_workdir("resolved-provider");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let prompt_str = prompt.to_str().unwrap();

    let validated = Cli::parse_and_validate_from([
        "wrily-rig",
        "--mode",
        "single",
        "--model",
        "gpt-4o",
        "--workdir",
        workdir.to_str().unwrap(),
        "--prompt-file",
        prompt_str,
        "--max-tokens",
        "8192",
        "--timeout-ms",
        "60000",
    ])
    .expect("parse_and_validate");

    assert_eq!(validated.provider, Provider::OpenAi);
    assert_eq!(validated.model, "gpt-4o");
}

#[test]
fn ambiguous_model_returns_error() {
    let workdir = temp_workdir("ambiguous");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        model: "llama-3".into(),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(
        cli.resolve_provider(),
        Err(ConfigError::AmbiguousProvider {
            model: "llama-3".into(),
        })
    );
}

#[test]
fn missing_workdir_returns_workdir_not_found() {
    let workdir = temp_workdir("missing-workdir-check");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");
    let cli = Cli {
        workdir: PathBuf::from("/nonexistent"),
        ..base_cli(&workdir, &prompt)
    };

    assert_eq!(
        cli.validate(),
        Err(ConfigError::WorkdirNotFound(PathBuf::from("/nonexistent")))
    );
}

#[test]
fn missing_prompt_file_returns_prompt_file_missing() {
    let workdir = temp_workdir("missing-prompt");
    let missing_prompt = workdir.join("does-not-exist.txt");
    let cli = base_cli(&workdir, &missing_prompt);

    assert_eq!(
        cli.validate(),
        Err(ConfigError::PromptFileMissing(missing_prompt))
    );
}

#[test]
fn parses_all_seven_flags_from_argv() {
    let workdir = temp_workdir("argv");
    let prompt = write_prompt_file(&workdir, "prompt.txt", "hello");

    let cli = Cli::try_parse_from([
        "wrily-rig",
        "--mode",
        "team",
        "--model",
        "gpt-4o",
        "--provider",
        "openai",
        "--workdir",
        workdir.to_str().unwrap(),
        "--prompt-file",
        prompt.to_str().unwrap(),
        "--max-tokens",
        "4096",
        "--timeout-ms",
        "120000",
    ])
    .expect("parse argv");

    assert_eq!(cli.mode, Mode::Team);
    assert_eq!(cli.model, "gpt-4o");
    assert_eq!(cli.provider, Some(Provider::OpenAi));
    assert_eq!(cli.workdir, workdir);
    assert_eq!(cli.prompt_file, prompt);
    assert_eq!(cli.max_tokens, 4096);
    assert_eq!(cli.timeout_ms, 120_000);
}
