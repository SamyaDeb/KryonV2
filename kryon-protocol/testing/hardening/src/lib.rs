#![forbid(unsafe_code)]

use indexer_api::{ApiState, ProtocolEvent};
use keepers::{funding_actions, stale_oracle_actions, FundingJob, OracleFeedStatus};
use monitoring::{evaluate_oracles, evaluate_runtime, OracleMetrics, RuntimeMetrics};
use order_types::{MatchedFill, Order};
use protocol_core::{CoreError, OracleSnapshot, OracleSource, PRECISION};
use risk_engine::{FundingConfig, FundingState};
use soroban_sdk::testutils::Address as _;

pub fn run_service_invariants() -> Result<(), CoreError> {
    indexer_replay_is_deterministic()?;
    keepers_and_monitoring_agree_on_stale_oracle()?;
    funding_keeper_respects_min_interval()?;
    runtime_monitor_rejects_negative_bad_debt()?;
    Ok(())
}

fn indexer_replay_is_deterministic() -> Result<(), CoreError> {
    let env = soroban_sdk::Env::default();
    let maker = soroban_sdk::Address::generate(&env);
    let taker = soroban_sdk::Address::generate(&env);
    let events = vec![ProtocolEvent::FillSettled(MatchedFill {
        maker: order(maker, false, 1),
        taker: order(taker, true, 7),
        fill_size: PRECISION / 2,
        fill_price: 100 * PRECISION,
    })];

    let mut first = ApiState::default();
    let mut second = ApiState::default();
    first.apply_many(events.clone())?;
    second.apply_many(events)?;
    if first != second {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn keepers_and_monitoring_agree_on_stale_oracle() -> Result<(), CoreError> {
    let env = soroban_sdk::Env::default();
    let snapshot = OracleSnapshot {
        asset: soroban_sdk::Symbol::new(&env, "BTC"),
        price: 100 * PRECISION,
        confidence: PRECISION,
        source: OracleSource::Quorum,
        publish_time: 1,
        write_time: 1,
    };
    let keeper_actions = stale_oracle_actions(
        100,
        &[OracleFeedStatus {
            market_id: 1,
            snapshot: snapshot.clone(),
            max_age_secs: 60,
        }],
    )?;
    let alerts = evaluate_oracles(
        100,
        &[OracleMetrics {
            market_id: 1,
            snapshot,
            max_age_secs: 60,
        }],
    )?;
    if keeper_actions.is_empty() || alerts.is_empty() {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn funding_keeper_respects_min_interval() -> Result<(), CoreError> {
    let actions = funding_actions(
        30,
        &[FundingJob {
            market_id: 1,
            config: FundingConfig {
                imbalance_coeff: PRECISION / 100,
                max_rate_per_hour: PRECISION / 100,
            },
            state: FundingState {
                long_index: 0,
                short_index: 0,
                rate_per_hour: 0,
                last_update: 0,
            },
            long_oi: 9 * PRECISION,
            short_oi: PRECISION,
            min_interval_secs: 60,
        }],
    )?;
    if !actions.is_empty() {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn runtime_monitor_rejects_negative_bad_debt() -> Result<(), CoreError> {
    match evaluate_runtime(&RuntimeMetrics {
        latest_ledger: 1,
        matcher_queue_depth: 0,
        settlement_failures: 0,
        liquidation_backlog: 0,
        bad_debt: -1,
    }) {
        Err(CoreError::InvalidAmount) => Ok(()),
        _ => Err(CoreError::InvalidConfig),
    }
}

fn order(owner: soroban_sdk::Address, is_long: bool, nonce: u64) -> Order {
    Order {
        owner,
        market_id: 1,
        is_long,
        size: PRECISION,
        limit_price: 100 * PRECISION,
        reduce_only: false,
        nonce,
        expiry_ts: 100,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_invariants_hold() {
        run_service_invariants().unwrap();
    }
}
