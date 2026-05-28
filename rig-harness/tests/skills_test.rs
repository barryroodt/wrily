use tempfile::TempDir;
use wrily_rig::emitter::TestEmitterGuard;
use wrily_rig::events::{SkillSource, WrilyEvent};
use wrily_rig::skills::{SkillLoader, AUTO_INJECT_SET};

#[test]
fn valid_name_accepts_good_names() {
    assert!(SkillLoader::valid_name("good-name"));
    assert!(SkillLoader::valid_name("good_name"));
    assert!(SkillLoader::valid_name("Skill123"));
}

#[test]
fn valid_name_rejects_bad_names() {
    assert!(!SkillLoader::valid_name("../bad"));
    assert!(!SkillLoader::valid_name(""));
    assert!(!SkillLoader::valid_name(&"a".repeat(65)));
}

#[test]
fn resolve_finds_workdir_skill() {
    let dir = TempDir::new().unwrap();
    let skill_dir = dir.path().join(".claude/skills/caveman-review");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), "workdir override content").unwrap();

    let loader = SkillLoader::new(dir.path().to_path_buf());
    let skill = loader.resolve("caveman-review").expect("skill");
    assert_eq!(skill.content, "workdir override content");
    assert_eq!(skill.source, SkillSource::Workdir);
}

#[test]
fn resolve_falls_back_to_bundled() {
    let dir = TempDir::new().unwrap();
    let loader = SkillLoader::new(dir.path().to_path_buf());
    let skill = loader.resolve("caveman-review").expect("bundled skill");
    assert_eq!(skill.source, SkillSource::Bundled);
    assert!(!skill.content.is_empty());
    assert!(skill.content.contains("caveman-review"));
}

#[test]
fn resolve_returns_none_for_unknown_skill() {
    let dir = TempDir::new().unwrap();
    let loader = SkillLoader::new(dir.path().to_path_buf());
    assert!(loader.resolve("not-a-real-skill").is_none());
}

#[test]
fn resolve_rejects_path_traversal_name() {
    let dir = TempDir::new().unwrap();
    let loader = SkillLoader::new(dir.path().to_path_buf());
    assert!(loader.resolve("../etc").is_none());
}

#[test]
fn inject_core_skills_concatenates_all_four() {
    let dir = TempDir::new().unwrap();
    let loader = SkillLoader::new(dir.path().to_path_buf());
    let guard = TestEmitterGuard::install();
    let prefix = loader.inject_core_skills();

    for name in AUTO_INJECT_SET {
        assert!(
            prefix.contains(&format!("<skill name=\"{name}\">")),
            "missing wrapper for {name}"
        );
        assert!(prefix.contains("</skill>"));
    }

    let events = guard.drain_events();
    assert_eq!(events.len(), AUTO_INJECT_SET.len());
    for event in events {
        match event {
            WrilyEvent::SkillLoaded { source, .. } => {
                assert_eq!(source, SkillSource::Bundled);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
