#![forbid(unsafe_code)]

use protocol_core::{CoreError, OracleSnapshot, Position};
use risk_engine::{update_from_imbalance, AccountHealth, FundingConfig, FundingState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeeperAction {
    PublishOracle {
        market_id: u32,
    },
    UpdateFunding {
        market_id: u32,
    },
    Liquidate {
        account_id: String,
        position_id: u64,
        close_size: i128,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleFeedStatus {
    pub market_id: u32,
    pub snapshot: OracleSnapshot,
    pub max_age_secs: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingJob {
    pub market_id: u32,
    pub config: FundingConfig,
    pub state: FundingState,
    pub long_oi: i128,
    pub short_oi: i128,
    pub min_interval_secs: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationCandidate {
    pub account_id: String,
    pub health: AccountHealth,
    pub positions: Vec<Position>,
}

pub fn stale_oracle_actions(
    now: u64,
    feeds: &[OracleFeedStatus],
) -> Result<Vec<KeeperAction>, CoreError> {
    let mut actions = Vec::new();
    for feed in feeds {
        if feed.snapshot.publish_time > now || feed.snapshot.write_time > now {
            return Err(CoreError::StaleOracle);
        }
        let publish_age = now.saturating_sub(feed.snapshot.publish_time);
        let write_age = now.saturating_sub(feed.snapshot.write_time);
        if publish_age > feed.max_age_secs || write_age > feed.max_age_secs {
            actions.push(KeeperAction::PublishOracle {
                market_id: feed.market_id,
            });
        }
    }
    Ok(actions)
}

pub fn funding_actions(now: u64, jobs: &[FundingJob]) -> Result<Vec<KeeperAction>, CoreError> {
    let mut actions = Vec::new();
    for job in jobs {
        if now <= job.state.last_update {
            continue;
        }
        if now - job.state.last_update < job.min_interval_secs {
            continue;
        }
        let next = update_from_imbalance(&job.config, &job.state, job.long_oi, job.short_oi, now)?;
        if next != job.state {
            actions.push(KeeperAction::UpdateFunding {
                market_id: job.market_id,
            });
        }
    }
    Ok(actions)
}

pub fn liquidation_actions(
    candidates: &[LiquidationCandidate],
    max_positions_per_account: usize,
) -> Result<Vec<KeeperAction>, CoreError> {
    if max_positions_per_account == 0 {
        return Err(CoreError::InvalidConfig);
    }
    let mut actions = Vec::new();
    for candidate in candidates {
        if !candidate.health.liquidatable {
            continue;
        }
        for position in candidate.positions.iter().take(max_positions_per_account) {
            if position.size <= 0 {
                continue;
            }
            actions.push(KeeperAction::Liquidate {
                account_id: candidate.account_id.clone(),
                position_id: position.position_id,
                close_size: position.size,
            });
            break;
        }
    }
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{MarginMode, OracleSource, PRECISION};
    use risk_engine::AccountHealth;
    use soroban_sdk::{testutils::Address as _, Env, Symbol};

    #[test]
    fn detects_stale_oracle_feed() {
        let env = Env::default();
        let actions = stale_oracle_actions(
            100,
            &[OracleFeedStatus {
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

        assert_eq!(actions, vec![KeeperAction::PublishOracle { market_id: 1 }]);
    }

    #[test]
    fn schedules_funding_update_after_interval() {
        let actions = funding_actions(
            3_600,
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
        )
        .unwrap();

        assert_eq!(actions, vec![KeeperAction::UpdateFunding { market_id: 1 }]);
    }

    #[test]
    fn picks_one_liquidation_action_per_unhealthy_account() {
        let actions = liquidation_actions(
            &[LiquidationCandidate {
                account_id: "account-1".to_string(),
                health: AccountHealth {
                    collateral_value: 0,
                    unrealized_pnl: -PRECISION,
                    equity: -PRECISION,
                    initial_margin_required: PRECISION,
                    maintenance_margin_required: PRECISION,
                    free_collateral: -PRECISION,
                    margin_ratio: -PRECISION,
                    liquidatable: true,
                },
                positions: vec![Position {
                    position_id: 9,
                    owner: soroban_sdk::Address::generate(&Env::default()),
                    market_id: 1,
                    size: PRECISION,
                    entry_price: 100 * PRECISION,
                    margin: 0,
                    is_long: true,
                    last_funding_index: 0,
                    mode: MarginMode::Cross,
                }],
            }],
            4,
        )
        .unwrap();

        assert_eq!(
            actions,
            vec![KeeperAction::Liquidate {
                account_id: "account-1".to_string(),
                position_id: 9,
                close_size: PRECISION,
            }]
        );
    }
}
