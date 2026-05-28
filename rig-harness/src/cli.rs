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

    #[error("CLI parse error: {0}")]
    CliParse(String),

    #[error("provider {provider:?} does not match model {model}")]
    ProviderModelMismatch { provider: Provider, model: String },

    #[error("prompt file not found: {}", .0.display())]
    PromptFileMissing(PathBuf),

    #[error("prompt file is not readable: {}", .0.display())]
    PromptFileNotReadable(PathBuf),

    #[error("workdir not found: {}", .0.display())]
    WorkdirNotFound(PathBuf),

    #[error("workdir is not a directory: {}", .0.display())]
    WorkdirNotDirectory(PathBuf),
}

impl From<clap::Error> for ConfigError {
    fn from(err: clap::Error) -> Self {
        ConfigError::CliParse(err.to_string())
    }
}

/// Fully validated CLI configuration ready for the harness run loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Validated {
    pub mode: Mode,
    pub model: String,
    pub provider: Provider,
    pub workdir: PathBuf,
    pub prompt_file: PathBuf,
    pub max_tokens: u64,
    pub timeout_ms: u64,
}

impl Cli {
    pub fn parse_and_validate() -> Result<Validated, ConfigError> {
        Self::try_parse()
            .map_err(ConfigError::from)
            .and_then(Self::into_validated)
    }

    pub fn parse_and_validate_from<I, T>(iter: I) -> Result<Validated, ConfigError>
    where
        I: IntoIterator<Item = T>,
        T: Into<std::ffi::OsString> + Clone,
    {
        Self::try_parse_from(iter)
            .map_err(ConfigError::from)
            .and_then(Self::into_validated)
    }

    fn into_validated(self) -> Result<Validated, ConfigError> {
        let workdir = self
            .workdir
            .canonicalize()
            .map_err(|_| ConfigError::WorkdirNotFound(self.workdir.clone()))?;
        if !workdir.is_dir() {
            return Err(ConfigError::WorkdirNotFound(workdir));
        }
        if !self.prompt_file.exists() {
            return Err(ConfigError::PromptFileMissing(self.prompt_file.clone()));
        }
        let provider = self.resolve_provider()?;
        Ok(Validated {
            mode: self.mode,
            model: self.model,
            provider,
            workdir,
            prompt_file: self.prompt_file,
            max_tokens: self.max_tokens,
            timeout_ms: self.timeout_ms,
        })
    }

    pub fn resolve_provider(&self) -> Result<Provider, ConfigError> {
        if let Some(explicit) = &self.provider {
            match infer_provider_from_model(&self.model) {
                Ok(inferred) if inferred != *explicit => {
                    Err(ConfigError::ProviderModelMismatch {
                        provider: explicit.clone(),
                        model: self.model.clone(),
                    })
                }
                Ok(_) | Err(ConfigError::AmbiguousProvider { .. }) => Ok(explicit.clone()),
                Err(e) => Err(e),
            }
        } else {
            infer_provider_from_model(&self.model)
        }
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
