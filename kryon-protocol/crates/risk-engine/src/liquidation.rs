use crate::margin::{account_health, AccountHealth};
use protocol_core::{
    apply_bps, checked_sub, notional, AccountSnapshot, CoreError, MarketSnapshot, Position,
};
use soroban_sdk::{contracttype, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiquidationMode {
    None,
    Partial,
    Full,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationPlan {
    pub mode: LiquidationMode,
    pub position_id: u64,
    pub close_size: i128,
    pub penalty: i128,
    pub expected_health: AccountHealth,
}

pub fn plan_liquidation(
    env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
    target_position_id: u64,
    partial_liquidation_bps: u32,
) -> Result<LiquidationPlan, CoreError> {
    let health = account_health(env, account, markets)?;
    if !health.liquidatable {
        return Err(CoreError::NotLiquidatable);
    }
    if partial_liquidation_bps == 0 || partial_liquidation_bps > 10_000 {
        return Err(CoreError::InvalidConfig);
    }

    let position = find_position(account, target_position_id)?;
    let market = markets
        .get(position.market_id)
        .ok_or(CoreError::InvalidConfig)?;

    let shortfall = checked_sub(health.maintenance_margin_required, health.equity)?;
    let position_notional = notional(position.size, market.oracle_price)?;
    let max_partial_size =
        protocol_core::mul_div(position.size, partial_liquidation_bps as i128, 10_000)?;
    let min_size_to_cover = protocol_core::mul_div(position.size, shortfall, position_notional)?;
    let close_size = if min_size_to_cover >= position.size {
        position.size
    } else {
        core::cmp::max(min_size_to_cover, max_partial_size)
    };
    let mode = if close_size >= position.size {
        LiquidationMode::Full
    } else {
        LiquidationMode::Partial
    };
    let penalty = apply_bps(
        notional(close_size, market.oracle_price)?,
        market.config.liquidation_fee_bps,
    )?;

    Ok(LiquidationPlan {
        mode,
        position_id: target_position_id,
        close_size,
        penalty,
        expected_health: health,
    })
}

fn find_position(account: &AccountSnapshot, position_id: u64) -> Result<Position, CoreError> {
    for p in account.positions.iter() {
        if p.position_id == position_id {
            return Ok(p);
        }
    }
    Err(CoreError::InvalidConfig)
}
