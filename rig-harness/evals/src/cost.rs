pub const PRICE_TABLE: &[(&str, f64, f64)] = &[
    // (model_prefix, input_per_1M, output_per_1M) in USD
    ("claude-haiku", 1.00, 5.00),
    ("claude-sonnet", 3.00, 15.00),
    ("claude-opus", 15.00, 75.00),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.00),
    ("composer-2.5", 0.50, 2.00),
    ("gemini-1.5", 0.075, 0.30),
];

pub fn cost_usd(model: &str, input: u64, output: u64) -> f64 {
    let (in_price, out_price) = PRICE_TABLE
        .iter()
        .find(|(p, _, _)| model.starts_with(p))
        .map(|(_, i, o)| (*i, *o))
        .unwrap_or((0.0, 0.0));
    (input as f64 / 1_000_000.0) * in_price + (output as f64 / 1_000_000.0) * out_price
}

pub const SPEND_CAP_USD: f64 = 5.0;

pub fn emit_spend_summary(total_usd: f64, cap_usd: f64, aborted: bool) {
    println!("eval spend: ${total_usd:.4} / ${cap_usd:.2} cap");
    if let Ok(summary_path) = std::env::var("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(summary_path)
        {
            let _ = writeln!(file, "## Eval spend\n");
            let _ = writeln!(file, "Total: ${total_usd:.4} / ${cap_usd:.2} cap");
            if aborted {
                let _ = writeln!(file, "\n**Aborted:** spend cap exceeded.");
            }
        }
    }
}
