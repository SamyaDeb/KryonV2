#![forbid(unsafe_code)]

use protocol_core::{CoreError, OracleSnapshot};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AlertSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Alert {
    pub severity: AlertSeverity,
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeMetrics {
    pub latest_ledger: u32,
    pub matcher_queue_depth: u64,
    pub settlement_failures: u64,
    pub liquidation_backlog: u64,
    pub bad_debt: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleMetrics {
    pub market_id: u32,
    pub snapshot: OracleSnapshot,
    pub max_age_secs: u64,
}

pub fn evaluate_runtime(metrics: &RuntimeMetrics) -> Result<Vec<Alert>, CoreError> {
    if metrics.bad_debt < 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut alerts = Vec::new();
    if metrics.settlement_failures > 0 {
        alerts.push(Alert {
            severity: AlertSeverity::Critical,
            code: "settlement_failures",
            message: format!(
                "{} settlement failures require investigation",
                metrics.settlement_failures
            ),
        });
    }
    if metrics.liquidation_backlog > 100 {
        alerts.push(Alert {
            severity: AlertSeverity::Critical,
            code: "liquidation_backlog",
            message: format!(
                "{} accounts are queued for liquidation",
                metrics.liquidation_backlog
            ),
        });
    }
    if metrics.matcher_queue_depth > 10_000 {
        alerts.push(Alert {
            severity: AlertSeverity::Warning,
            code: "matcher_queue_depth",
            message: format!("matcher queue depth is {}", metrics.matcher_queue_depth),
        });
    }
    if metrics.bad_debt > 0 {
        alerts.push(Alert {
            severity: AlertSeverity::Critical,
            code: "bad_debt",
            message: format!("bad debt is {}", metrics.bad_debt),
        });
    }
    Ok(alerts)
}

pub fn evaluate_oracles(now: u64, metrics: &[OracleMetrics]) -> Result<Vec<Alert>, CoreError> {
    let mut alerts = Vec::new();
    for metric in metrics {
        if metric.snapshot.publish_time > now || metric.snapshot.write_time > now {
            return Err(CoreError::StaleOracle);
        }
        let publish_age = now.saturating_sub(metric.snapshot.publish_time);
        let write_age = now.saturating_sub(metric.snapshot.write_time);
        if publish_age > metric.max_age_secs || write_age > metric.max_age_secs {
            alerts.push(Alert {
                severity: AlertSeverity::Critical,
                code: "stale_oracle",
                message: format!("market {} oracle is stale", metric.market_id),
            });
        }
    }
    Ok(alerts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{OracleSource, PRECISION};
    use soroban_sdk::{Env, Symbol};

    #[test]
    fn runtime_alerts_on_bad_debt_and_failures() {
        let alerts = evaluate_runtime(&RuntimeMetrics {
            latest_ledger: 1,
            matcher_queue_depth: 0,
            settlement_failures: 1,
            liquidation_backlog: 0,
            bad_debt: PRECISION,
        })
        .unwrap();

        assert_eq!(alerts.len(), 2);
        assert!(alerts.iter().any(|a| a.code == "bad_debt"));
    }

    #[test]
    fn oracle_alerts_on_stale_feed() {
        let env = Env::default();
        let alerts = evaluate_oracles(
            100,
            &[OracleMetrics {
                market_id: 1,
                snapshot: OracleSnapshot {
                    asset: Symbol::new(&env, "BTC"),
                    price: 100 * PRECISION,
                    confidence: PRECISION,
                    source: OracleSource::Quorum,
                    publish_time: 1,
                    write_time: 1,
                },
                max_age_secs: 60,
            }],
        )
        .unwrap();

        assert_eq!(alerts[0].code, "stale_oracle");
    }
}
