use wrily_rig_evals::{cost_usd, SPEND_CAP_USD};

#[test]
fn cost_usd_matches_haiku_pricing() {
    let cost = cost_usd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
    assert!((cost - 6.0).abs() < f64::EPSILON);
}

#[test]
fn cost_usd_unknown_model_is_zero() {
    assert_eq!(cost_usd("unknown-model", 1_000_000, 1_000_000), 0.0);
}

#[test]
fn spend_cap_is_five_dollars() {
    assert!((SPEND_CAP_USD - 5.0).abs() < f64::EPSILON);
}
