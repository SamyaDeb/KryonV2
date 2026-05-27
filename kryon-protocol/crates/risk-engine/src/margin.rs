use protocol_core::{
    add_signed, apply_bps, checked_add, checked_sub, collateral_value_after_haircut, funding_pnl,
    notional, signed_position_pnl, AccountSnapshot, CoreError, MarketSnapshot, PRECISION,
};
use soroban_sdk::{contracttype, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountHealth {
    pub collateral_value: i128,
    pub unrealized_pnl: i128,
    pub equity: i128,
    pub initial_margin_required: i128,
    pub maintenance_margin_required: i128,
    pub free_collateral: i128,
    pub margin_ratio: i128,
    pub liquidatable: bool,
}

pub fn account_health(
    _env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
) -> Result<AccountHealth, CoreError> {
    let mut collateral_value = 0i128;
    for c in account.collateral.iter() {
        collateral_value = checked_add(
            collateral_value,
            collateral_value_after_haircut(c.value, c.haircut_bps)?,
        )?;
    }

    let mut unrealized_pnls = [0i128; 64];
    let mut pnl_count = 0usize;
    let mut initial = 0i128;
    let mut maintenance = 0i128;

    for p in account.positions.iter() {
        if pnl_count >= unrealized_pnls.len() {
            return Err(CoreError::InvalidConfig);
        }
        let market = markets.get(p.market_id).ok_or(CoreError::InvalidConfig)?;
        if !market.config.active {
            return Err(CoreError::InvalidConfig);
        }
        let current_funding = if p.is_long {
            market.funding_index_long
        } else {
            market.funding_index_short
        };
        let trade_pnl = signed_position_pnl(&p, market.oracle_price)?;
        let f_pnl = funding_pnl(&p, current_funding)?;
        unrealized_pnls[pnl_count] = checked_add(trade_pnl, f_pnl)?;
        pnl_count += 1;

        let n = notional(p.size, market.oracle_price)?;
        initial = checked_add(initial, apply_bps(n, market.config.initial_margin_bps)?)?;
        maintenance = checked_add(
            maintenance,
            apply_bps(n, market.config.maintenance_margin_bps)?,
        )?;
    }

    let unrealized_pnl = add_signed(&unrealized_pnls[..pnl_count])?;
    let equity = checked_add(collateral_value, unrealized_pnl)?;
    let free_collateral = checked_sub(equity, initial)?;
    let margin_ratio = if maintenance > 0 {
        protocol_core::div_precision(equity, maintenance)?
    } else {
        i128::MAX
    };

    Ok(AccountHealth {
        collateral_value,
        unrealized_pnl,
        equity,
        initial_margin_required: initial,
        maintenance_margin_required: maintenance,
        free_collateral,
        margin_ratio,
        liquidatable: maintenance > 0 && equity < maintenance,
    })
}

pub fn validate_withdrawal(
    env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
    withdrawal_value: i128,
) -> Result<AccountHealth, CoreError> {
    if withdrawal_value < 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut health = account_health(env, account, markets)?;
    health.collateral_value = checked_sub(health.collateral_value, withdrawal_value)?;
    health.equity = checked_sub(health.equity, withdrawal_value)?;
    health.free_collateral = checked_sub(health.equity, health.initial_margin_required)?;
    health.margin_ratio = if health.maintenance_margin_required > 0 {
        protocol_core::div_precision(health.equity, health.maintenance_margin_required)?
    } else {
        i128::MAX
    };
    health.liquidatable = health.maintenance_margin_required > 0
        && health.equity < health.maintenance_margin_required;
    if health.equity < health.initial_margin_required {
        return Err(CoreError::InsufficientCollateral);
    }
    Ok(health)
}

pub fn max_leverage_bps(initial_margin_bps: u32) -> Result<i128, CoreError> {
    if initial_margin_bps == 0 {
        return Err(CoreError::InvalidConfig);
    }
    protocol_core::mul_div(10_000, PRECISION, initial_margin_bps as i128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{
        CollateralBalance, MarginMode, MarketConfig, MarketSnapshot, Position, PRECISION,
    };
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Vec};

    fn setup_account(env: &Env, mark: i128) -> (AccountSnapshot, Map<u32, MarketSnapshot>) {
        let user = Address::generate(env);
        let token = Address::generate(env);
        let market_token = Address::generate(env);
        let collateral = Vec::from_array(
            env,
            [CollateralBalance {
                asset: token,
                amount: 1_000 * PRECISION,
                value: 1_000 * PRECISION,
                haircut_bps: 0,
            }],
        );
        let positions = Vec::from_array(
            env,
            [Position {
                position_id: 1,
                owner: user.clone(),
                market_id: 1,
                size: 10 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 100 * PRECISION,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            }],
        );
        let account = AccountSnapshot {
            owner: user,
            collateral,
            positions,
        };
        let mut markets = Map::new(env);
        markets.set(
            1,
            MarketSnapshot {
                config: MarketConfig {
                    market_id: 1,
                    base_asset: Symbol::new(env, "BTC"),
                    settlement_asset: market_token,
                    max_leverage_bps: 100_000,
                    initial_margin_bps: 1_000,
                    maintenance_margin_bps: 500,
                    liquidation_fee_bps: 50,
                    max_open_interest: 10_000 * PRECISION,
                    max_oracle_age_secs: 10,
                    max_oracle_confidence_bps: 50,
                    active: true,
                },
                oracle_price: mark,
                funding_index_long: 0,
                funding_index_short: 0,
            },
        );
        (account, markets)
    }

    #[test]
    fn withdrawal_uses_unrealized_loss_not_locked_margin() {
        let env = Env::default();
        let (account, markets) = setup_account(&env, 10 * PRECISION);
        let health = account_health(&env, &account, &markets).unwrap();
        assert_eq!(health.unrealized_pnl, -900 * PRECISION);
        assert!(validate_withdrawal(&env, &account, &markets, 900 * PRECISION).is_err());
    }
}
