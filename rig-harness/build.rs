use std::env;
use std::fs;
use std::path::PathBuf;

const AUTO_INJECT_SKILLS: &[&str] = &[
    "caveman-review",
    "agent-team-review",
    "code-review",
    "confidence-rating",
];

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let skills_out = out_dir.join("skills");
    fs::create_dir_all(&skills_out).expect("create OUT_DIR/skills");

    let repo_skills = manifest_dir.join("../skills");

    for name in AUTO_INJECT_SKILLS {
        let src = repo_skills.join(name).join("SKILL.md");
        let dest = skills_out.join(format!("{name}.md"));

        if !src.is_file() {
            panic!(
                "bundled skill source missing: {} (expected wrily/skills/{name}/SKILL.md)",
                src.display()
            );
        }

        fs::copy(&src, &dest).unwrap_or_else(|e| {
            panic!(
                "failed to copy {} -> {}: {e}",
                src.display(),
                dest.display()
            );
        });

        println!("cargo:rerun-if-changed={}", src.display());
    }

    println!("cargo:rerun-if-changed={}", manifest_dir.join("build.rs").display());
}
