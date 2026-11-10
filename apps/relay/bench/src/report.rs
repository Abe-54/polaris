//! Results as JSON and as tables, and the comparison of two results.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    Lower,
    Higher,
    /// Reported, never judged: sizes and rates the scenario fixes.
    Info,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metric {
    pub name: String,
    /// The median over the runs.
    pub value: f64,
    pub unit: String,
    pub better: Better,
    pub runs: Vec<f64>,
}

impl Metric {
    pub fn new(name: &str, value: f64, unit: &str, better: Better) -> Self {
        Self { name: name.into(), value, unit: unit.into(), better, runs: vec![value] }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScenarioResult {
    pub name: String,
    pub metrics: Vec<Metric>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Result {
    pub label: String,
    pub target: String,
    pub quick: bool,
    pub runs: usize,
    pub env: BTreeMap<String, String>,
    pub scenarios: Vec<ScenarioResult>,
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;

    if values.len() % 2 == 1 { values[middle] } else { (values[middle - 1] + values[middle]) / 2.0 }
}

/// One scenario's metrics over several runs, each metric at its median.
pub fn merge(name: &str, runs: Vec<Vec<Metric>>) -> ScenarioResult {
    let mut metrics: Vec<Metric> = Vec::new();

    for run in runs {
        for metric in run {
            match metrics.iter_mut().find(|known| known.name == metric.name) {
                Some(known) => known.runs.push(metric.value),
                None => metrics.push(metric),
            }
        }
    }

    for metric in &mut metrics {
        metric.value = median(&mut metric.runs.clone());
    }

    ScenarioResult { name: name.into(), metrics }
}

fn number(value: f64) -> String {
    match value.abs() {
        v if v >= 1000.0 => format!("{value:.0}"),
        v if v >= 100.0 => format!("{value:.1}"),
        v if v >= 1.0 => format!("{value:.2}"),
        _ => format!("{value:.3}"),
    }
}

pub fn print(result: &Result) {
    println!("\n{} ({}{})", result.label, result.target, if result.quick { ", quick" } else { "" });

    for scenario in &result.scenarios {
        println!("\n  {}", scenario.name);

        for metric in &scenario.metrics {
            let spread = match (metric.runs.iter().copied().reduce(f64::min), metric.runs.len()) {
                (Some(low), runs) if runs > 1 => {
                    let high = metric.runs.iter().copied().fold(f64::MIN, f64::max);
                    format!("  [{} to {}]", number(low), number(high))
                }
                _ => String::new(),
            };

            println!(
                "    {:<28} {:>12} {}{}",
                metric.name,
                number(metric.value),
                metric.unit,
                spread
            );
        }
    }
}

/// How much better `new` is than `base`: 2.0 is twice as good, 0.5 twice as bad.
fn gain(base: f64, new: f64, better: Better) -> Option<f64> {
    if base <= 0.0 || new <= 0.0 {
        return None;
    }

    match better {
        Better::Lower => Some(base / new),
        Better::Higher => Some(new / base),
        Better::Info => None,
    }
}

/// Prints every metric of `base` beside the same metric of each other result.
pub fn compare(base: &Result, others: &[Result]) {
    print!("\n{:<44} {:>14}", "", base.label);

    for other in others {
        print!(" {:>24}", other.label);
    }

    println!();

    for scenario in &base.scenarios {
        println!("{}", scenario.name);

        for metric in &scenario.metrics {
            print!(
                "  {:<42} {:>14}",
                format!("{} ({})", metric.name, metric.unit),
                number(metric.value)
            );

            for other in others {
                let found = other
                    .scenarios
                    .iter()
                    .find(|s| s.name == scenario.name)
                    .and_then(|s| s.metrics.iter().find(|m| m.name == metric.name));

                match found {
                    Some(m) => match gain(metric.value, m.value, metric.better) {
                        Some(g) => print!(" {:>14} {:>9}", number(m.value), format!("{g:.2}x")),
                        None => print!(" {:>14} {:>9}", number(m.value), ""),
                    },
                    None => print!(" {:>24}", "-"),
                }
            }

            println!();
        }
    }
}
