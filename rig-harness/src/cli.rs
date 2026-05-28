use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "wrily-rig", about = "Wrily Rig harness sidecar")]
pub struct Cli {
    #[arg(long)]
    pub workdir: Option<String>,
}

pub fn parse() -> Cli {
    Cli::parse()
}
