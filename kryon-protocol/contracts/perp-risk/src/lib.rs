#![no_std]
#![deny(unsafe_code)]

use protocol_core::{AccountSnapshot, CoreError, MarketSnapshot};
use risk_engine::{
    account_health, plan_liquidation, validate_withdrawal, AccountHealth, LiquidationPlan,
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Market(u32),
}

#[contract]
pub struct PerpRiskContract;

#[contractimpl]
impl PerpRiskContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::InvalidConfig);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn nominate_admin(env: Env, next_admin: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &next_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), CoreError> {
        let next_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(CoreError::InvalidConfig)?;
        next_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &next_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    pub fn set_market(env: Env, market: MarketSnapshot) -> Result<(), CoreError> {
        require_admin(&env)?;
        if market.config.market_id == 0 || market.oracle_price <= 0 {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Market(market.config.market_id), &market);
        Ok(())
    }

    pub fn get_account_health(
        env: Env,
        account: AccountSnapshot,
    ) -> Result<AccountHealth, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        account_health(&env, &account, &markets)
    }

    pub fn validate_withdraw(
        env: Env,
        account: AccountSnapshot,
        withdrawal_value: i128,
    ) -> Result<AccountHealth, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        validate_withdrawal(&env, &account, &markets, withdrawal_value)
    }

    pub fn liquidation_plan(
        env: Env,
        account: AccountSnapshot,
        position_id: u64,
        partial_liquidation_bps: u32,
    ) -> Result<LiquidationPlan, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        plan_liquidation(
            &env,
            &account,
            &markets,
            position_id,
            partial_liquidation_bps,
        )
    }
}

fn require_admin(env: &Env) -> Result<Address, CoreError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(CoreError::InvalidConfig)?;
    admin.require_auth();
    Ok(admin)
}

fn load_markets_for_account(
    env: &Env,
    account: &AccountSnapshot,
) -> Result<Map<u32, MarketSnapshot>, CoreError> {
    let mut out = Map::new(env);
    for position in account.positions.iter() {
        if out.contains_key(position.market_id) {
            continue;
        }
        let market = env
            .storage()
            .persistent()
            .get(&DataKey::Market(position.market_id))
            .ok_or(CoreError::InvalidConfig)?;
        out.set(position.market_id, market);
    }
    Ok(out)
}
