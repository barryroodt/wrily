use crate::events::{now_ms, SkillSource, WrilyEvent};
use std::path::PathBuf;

pub const AUTO_INJECT_SET: &[&str] = &[
    "caveman-review",
    "agent-team-review",
    "code-review",
    "confidence-rating",
];

pub struct ResolvedSkill {
    pub name: String,
    pub content: String,
    pub source: SkillSource,
    pub bytes: u64,
}

pub struct SkillLoader {
    workdir: PathBuf,
}

impl SkillLoader {
    pub fn new(workdir: PathBuf) -> Self {
        Self { workdir }
    }

    /// Validate skill name per ADR-0002 (`^[A-Za-z0-9_-]+$`, max 64 chars).
    pub fn valid_name(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 64
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    /// Resolve a single skill: workdir → bundled. Returns `None` if not found.
    pub fn resolve(&self, name: &str) -> Option<ResolvedSkill> {
        if !Self::valid_name(name) {
            return None;
        }

        if let Ok(workdir) = self.workdir.canonicalize() {
            let skill_path = workdir
                .join(".claude")
                .join("skills")
                .join(name)
                .join("SKILL.md");

            if skill_path.is_file() {
                if let Ok(canonical) = skill_path.canonicalize() {
                    if canonical.starts_with(&workdir) {
                        if let Ok(content) = std::fs::read_to_string(&canonical) {
                            let bytes = content.len() as u64;
                            return Some(ResolvedSkill {
                                name: name.to_string(),
                                content,
                                source: SkillSource::Workdir,
                                bytes,
                            });
                        }
                    }
                }
            }
        }

        bundled_skill(name).map(|content| ResolvedSkill {
            name: name.to_string(),
            content: content.to_string(),
            source: SkillSource::Bundled,
            bytes: content.len() as u64,
        })
    }

    /// Load the auto-inject set; emit one `skill_loaded` per skill found; build the
    /// concatenated system-prompt prefix.
    pub fn inject_core_skills(&self) -> String {
        let mut prefix = String::new();
        for name in AUTO_INJECT_SET {
            match self.resolve(name) {
                Some(skill) => {
                    prefix.push_str(&format!("<skill name=\"{}\">\n", skill.name));
                    prefix.push_str(&skill.content);
                    prefix.push_str("\n</skill>\n\n");
                    let _ = WrilyEvent::SkillLoaded {
                        ts: now_ms(),
                        name: skill.name.clone(),
                        source: skill.source,
                        bytes: skill.bytes,
                    }
                    .emit();
                }
                None => {
                    eprintln!("warning: auto-inject skill {name} not resolved");
                }
            }
        }
        prefix
    }
}

fn bundled_skill(name: &str) -> Option<&'static str> {
    match name {
        "caveman-review" => Some(include_str!(concat!(
            env!("OUT_DIR"),
            "/skills/caveman-review.md"
        ))),
        "agent-team-review" => Some(include_str!(concat!(
            env!("OUT_DIR"),
            "/skills/agent-team-review.md"
        ))),
        "code-review" => Some(include_str!(concat!(
            env!("OUT_DIR"),
            "/skills/code-review.md"
        ))),
        "confidence-rating" => Some(include_str!(concat!(
            env!("OUT_DIR"),
            "/skills/confidence-rating.md"
        ))),
        _ => None,
    }
}
