#![forbid(unsafe_code)]

use indexer_api::ProtocolEvent;
use monitoring::{evaluate_runtime, RuntimeMetrics};
use node_runtime::{ingest_once, InMemoryStore, ReplayRpcSource, RpcEnvelope, TxQueue, TxStatus};
use order_types::{MatchedFill, Order};
use protocol_core::{CoreError, PRECISION};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadReport {
    pub events_ingested: usize,
    pub final_volume: i128,
    pub replay_verified: bool,
}

pub fn run_indexer_load(events: usize) -> Result<LoadReport, CoreError> {
    if events == 0 {
        return Err(CoreError::InvalidAmount);
    }
    let env = Env::default();
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);
    let rpc_events: Vec<RpcEnvelope> = (0..events)
        .map(|idx| RpcEnvelope {
            ledger: idx as u32 + 1,
            tx_hash: format!("tx-{idx}"),
            event: ProtocolEvent::FillSettled(MatchedFill {
                maker: order(maker.clone(), false, idx as u64 + 1),
                taker: order(taker.clone(), true, idx as u64 + 10_000),
                fill_size: PRECISION,
                fill_price: 100 * PRECISION,
            }),
        })
        .collect();

    let mut source = ReplayRpcSource::new(rpc_events);
    let mut store = InMemoryStore::default();
    let mut cursor = 0;
    while ingest_once(&mut source, &mut store, &mut cursor, 128)? > 0 {}
    let replay = store.replay()?;
    let final_volume = replay.market(1).ok_or(CoreError::InvalidConfig)?.volume;

    Ok(LoadReport {
        events_ingested: store.event_count(),
        final_volume,
        replay_verified: replay == *store.state(),
    })
}

pub fn run_tx_submission_chaos(jobs: usize, retry_limit: u32) -> Result<usize, CoreError> {
    if jobs == 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut queue = TxQueue::default();
    for idx in 0..jobs {
        queue.enqueue("settlement", format!("payload-{idx}"));
    }
    let mut failed = 0;
    while let Some(job) = queue.mark_next_attempt(retry_limit)? {
        if job.status == TxStatus::Failed {
            failed += 1;
        }
    }
    Ok(failed)
}

pub fn run_monitoring_chaos() -> Result<usize, CoreError> {
    let alerts = evaluate_runtime(&RuntimeMetrics {
        latest_ledger: 99,
        matcher_queue_depth: 50_000,
        settlement_failures: 2,
        liquidation_backlog: 500,
        bad_debt: PRECISION,
    })?;
    Ok(alerts.len())
}

fn order(owner: Address, is_long: bool, nonce: u64) -> Order {
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
    fn load_replay_is_deterministic() {
        let report = run_indexer_load(512).unwrap();
        assert_eq!(report.events_ingested, 512);
        assert_eq!(report.final_volume, 512 * PRECISION);
        assert!(report.replay_verified);
    }

    #[test]
    fn tx_chaos_eventually_marks_over_retried_jobs_failed() {
        assert_eq!(run_tx_submission_chaos(4, 0).unwrap(), 4);
    }

    #[test]
    fn monitoring_chaos_emits_multiple_alerts() {
        assert!(run_monitoring_chaos().unwrap() >= 4);
    }
}
