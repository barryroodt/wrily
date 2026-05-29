use tempfile::TempDir;
use wrily_rig::tools::skill_load::{skill_load, SkillLoadArgs};
use wrily_rig::tools::ToolError;

fn write_skill(workdir: &std::path::Path, name: &str, body: &str) {
    let skill_dir = workdir.join(".claude/skills").join(name);
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), body).unwrap();
}

#[tokio::test]
async fn skill_load_happy_path() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    write_skill(workdir, "specialist", "specialist body");

    let out = skill_load(
        workdir,
        SkillLoadArgs {
            name: "specialist".into(),
        },
    )
    .await
    .unwrap();

    assert_eq!(
        out.content,
        "<skill name=\"specialist\">\nspecialist body\n</skill>"
    );
    assert!(!out.truncated);
}

#[tokio::test]
async fn skill_load_missing_skill() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = skill_load(
        workdir,
        SkillLoadArgs {
            name: "missing-skill".into(),
        },
    )
    .await
    .unwrap_err();

    match err {
        ToolError::InvalidInput(msg) => assert!(msg.contains("skill not found")),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[tokio::test]
async fn skill_load_rejects_invalid_name() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = skill_load(
        workdir,
        SkillLoadArgs {
            name: "../etc".into(),
        },
    )
    .await
    .unwrap_err();

    match err {
        ToolError::InvalidInput(msg) => assert!(msg.contains("invalid skill name")),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[tokio::test]
async fn skill_load_rejects_symlink_escape() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    let outside = TempDir::new().unwrap();
    let secret_skill = outside.path().join("SKILL.md");
    std::fs::write(&secret_skill, "outside skill").unwrap();

    let skill_dir = workdir.join(".claude/skills").join("escape");
    std::fs::create_dir_all(&skill_dir).unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&secret_skill, skill_dir.join("SKILL.md")).unwrap();
    }
    #[cfg(not(unix))]
    {
        return;
    }

    let err = skill_load(
        workdir,
        SkillLoadArgs {
            name: "escape".into(),
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn skill_load_no_bundled_fallback() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = skill_load(
        workdir,
        SkillLoadArgs {
            name: "caveman-review".into(),
        },
    )
    .await
    .unwrap_err();

    match err {
        ToolError::InvalidInput(msg) => {
            assert!(msg.contains("skill not found"));
            assert!(msg.contains("caveman-review"));
        }
        other => panic!("expected workdir-only miss, got {other:?}"),
    }
}
