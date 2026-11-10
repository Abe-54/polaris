//! The relay's load generator: starts a relay, drives it over its real wire protocol, and
//! reports latency, throughput and what the relay process used (README.md).

mod party;
mod proc;
mod report;
mod scenarios;
mod target;
mod traffic;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command as Process;

use clap::{Parser, Subcommand};

use party::Failure;
use scenarios::SCENARIOS;
use target::TargetKind;

#[derive(Parser)]
#[command(about = "Benchmarks a Polaris Relay over its wire protocol")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Runs scenarios against a relay it starts.
    Run {
        /// `bun`, `rust`, or a command that serves the relay on $PORT.
        #[arg(long, default_value = "bun")]
        target: String,
        /// Scenarios to run, comma-separated (default: all).
        #[arg(long, value_delimiter = ',')]
        scenario: Vec<String>,
        /// Smaller sizes: seconds, not minutes.
        #[arg(long)]
        quick: bool,
        /// Runs per scenario; each metric reports its median.
        #[arg(long, default_value_t = 1)]
        runs: usize,
        /// Writes the result as JSON.
        #[arg(long)]
        json: Option<PathBuf>,
        /// Names the result in tables (default: the target).
        #[arg(long)]
        label: Option<String>,
        /// The load generator's worker threads.
        #[arg(long, default_value_t = 4)]
        threads: usize,
        /// Seconds of traffic before measuring. A relay on a JIT needs more than the default
        /// to reach the speed it holds in service.
        #[arg(long)]
        warm: Option<u64>,
    },
    /// Prints results side by side, each against the first.
    Compare { results: Vec<PathBuf> },
    /// Lists the scenarios.
    List,
}

fn output(program: &str, args: &[&str]) -> String {
    Process::new(program)
        .args(args)
        .current_dir(target::repo_root())
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default()
}

fn environment(threads: usize) -> BTreeMap<String, String> {
    let cores = std::thread::available_parallelism().map_or(0, usize::from);

    let cpu = if cfg!(target_os = "macos") {
        output("sysctl", &["-n", "machdep.cpu.brand_string"])
    } else {
        output("sh", &["-c", "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"])
    };

    BTreeMap::from([
        ("os".into(), std::env::consts::OS.into()),
        ("arch".into(), std::env::consts::ARCH.into()),
        ("cores".into(), cores.to_string()),
        ("cpu".into(), cpu),
        ("bun".into(), output("bun", &["--version"])),
        ("commit".into(), output("git", &["rev-parse", "--short", "HEAD"])),
        ("dirty".into(), (!output("git", &["status", "--porcelain"]).is_empty()).to_string()),
        ("loadgen_threads".into(), threads.to_string()),
        ("load_average".into(), format!("{:.1}", proc::load_average())),
    ])
}

fn load(path: &PathBuf) -> Result<report::Result, Failure> {
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

async fn run_all(
    kind: &TargetKind,
    names: &[String],
    quick: bool,
    runs: usize,
) -> Result<Vec<report::ScenarioResult>, Failure> {
    let mut results = Vec::new();

    for name in names {
        let mut each = Vec::new();

        for attempt in 1..=runs {
            eprintln!("{name}: run {attempt} of {runs}");
            each.push(scenarios::run(name, kind, quick).await?);
        }

        results.push(report::merge(name, each));
    }

    Ok(results)
}

fn main() -> Result<(), Failure> {
    match Cli::parse().command {
        Command::List => {
            for scenario in SCENARIOS {
                println!("{:<12} {}", scenario.name, scenario.about);
            }

            Ok(())
        }
        Command::Compare { results } => {
            let loaded = results.iter().map(load).collect::<Result<Vec<_>, _>>()?;
            let (base, others) = loaded.split_first().ok_or("name at least one result")?;
            report::compare(base, others);

            Ok(())
        }
        Command::Run { target, scenario, quick, runs, json, label, threads, warm } => {
            if let Some(seconds) = warm {
                let _ = scenarios::WARM.set(std::time::Duration::from_secs(seconds));
            }

            let names: Vec<String> = if scenario.is_empty() {
                SCENARIOS.iter().map(|s| s.name.to_owned()).collect()
            } else {
                scenario
            };

            let kind = TargetKind::parse(&target);
            let busy = proc::load_average();

            if busy > 4.0 {
                eprintln!("warning: load average {busy:.1}: other work will skew latencies");
            }

            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(threads.max(1))
                .enable_all()
                .build()?;

            let scenarios = runtime.block_on(run_all(&kind, &names, quick, runs.max(1)))?;

            let result = report::Result {
                label: label.unwrap_or_else(|| target.clone()),
                target,
                quick,
                runs: runs.max(1),
                env: environment(threads),
                scenarios,
            };

            report::print(&result);

            if let Some(path) = json {
                std::fs::write(&path, serde_json::to_string_pretty(&result)? + "\n")?;
            }

            let faulty = result.scenarios.iter().any(|scenario| {
                scenario
                    .metrics
                    .iter()
                    .any(|m| m.name == "faults" && m.runs.iter().any(|v| *v > 0.0))
            });

            if faulty { Err("frames were lost, reordered or refused".into()) } else { Ok(()) }
        }
    }
}
