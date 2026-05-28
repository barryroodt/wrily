use clap::{Parser, ValueEnum};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Parser, Debug, Clone)]
#[command(name = "wrily-rig", about = "Wrily Rig harness sidecar")]
pub struct Cli {
    #[arg(long)]
    pub mode: Mode,

    #[arg(long)]
    pub model: String,

    #[arg(long)]
    pub provider: Option<Provider>,

    #[arg(long)]
    pub workdir: PathBuf,

    #[arg(long = "prompt-file")]
    pub prompt_file: PathBuf,

    #[arg(long = "max-tokens")]
    pub max_tokens: u64,

    #[arg(long = "timeout-ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, ValueEnum)]
#[clap(rename_all = "lowercase")]
pub enum Mode {
    Single,
    Team,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Team => "team",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, ValueEnum)]
#[clap(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    OpenAi,
    Gemini,
    Cursor,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
        }
    }
}

const PROVIDER_PREFIXES: &[(&str, Provider)] = &[
    ("cursor-composer-", Provider::Cursor),
    ("composer-", Provider::Cursor),
    ("claude-", Provider::Anthropic),
    ("gpt-", Provider::OpenAi),
    ("gemini-", Provider::Gemini),
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("ambiguous provider for model {model}")]
    AmbiguousProvider { model: String },

    #[error("prompt file not found: {}", .0.display())]
    PromptFileMissing(PathBuf),

    #[error("prompt file is not readable: {}", .0.display())]
    PromptFileNotReadable(PathBuf),

    #[error("workdir not found: {}", .0.display())]
    WorkdirNotFound(PathBuf),

    #[error("workdir is not a directory: {}", .0.display())]
    WorkdirNotDirectory(PathBuf),
}

impl Cli {
    pub fn resolve_provider(&self) -> Result<Provider, ConfigError> {
        if let Some(provider) = &self.provider {
            return Ok(provider.clone());
        }

        infer_provider_from_model(&self.model)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_workdir(&self.workdir)?;
        validate_prompt_file(&self.prompt_file)?;
        Ok(())
    }
}

fn infer_provider_from_model(model: &str) -> Result<Provider, ConfigError> {
    if let Some((_, prov)) = PROVIDER_PREFIXES
        .iter()
        .find(|(p, _)| model.starts_with(p))
    {
        return Ok(prov.clone());
    }
    if let Some(rest) = model.strip_prefix('o') {
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            return Ok(Provider::OpenAi);
        }
    }
    Err(ConfigError::AmbiguousProvider {
        model: model.into(),
    })
}

fn validate_workdir(workdir: &Path) -> Result<(), ConfigError> {
    if !workdir.exists() {
        return Err(ConfigError::WorkdirNotFound(workdir.to_path_buf()));
    }
    if !workdir.is_dir() {
        return Err(ConfigError::WorkdirNotDirectory(workdir.to_path_buf()));
    }
    Ok(())
}

fn validate_prompt_file(prompt_file: &Path) -> Result<(), ConfigError> {
    if !prompt_file.exists() {
        return Err(ConfigError::PromptFileMissing(prompt_file.to_path_buf()));
    }
    if !prompt_file.is_file() {
        return Err(ConfigError::PromptFileNotReadable(prompt_file.to_path_buf()));
    }
    if std::fs::File::open(prompt_file).is_err() {
        return Err(ConfigError::PromptFileNotReadable(prompt_file.to_path_buf()));
    }
    Ok(())
}
