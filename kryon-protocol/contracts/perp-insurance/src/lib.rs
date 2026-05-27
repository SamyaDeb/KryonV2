#![no_std]
#![deny(unsafe_code)]

use protocol_core::{checked_add, checked_sub, CoreError};
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Liquidation,
    Balance(Address),
    BadDebt(Address),
}

#[contract]
pub struct PerpInsuranceContract;

#[contractimpl]
impl PerpInsuranceContract {
    pub fn initialize(env: Env, admin: Address, liquidation: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    pub fn set_liquidation(env: Env, liquidation: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
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

    pub fn deposit(
        env: Env,
        funder: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        funder.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&funder, &insurance, &amount);
        increase_balance(&env, &asset, amount)
    }

    pub fn pay_liquidator(
        env: Env,
        liquidator: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let balance = balance_of(env.clone(), asset.clone());
        if balance < amount {
            return Err(CoreError::InsuranceFundInsufficient);
        }
        let next = decrease_balance(&env, &asset, amount)?;
        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&insurance, &liquidator, &amount);
        Ok(next)
    }

    pub fn record_bad_debt(env: Env, asset: Address, amount: i128) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let current = bad_debt_of(env.clone(), asset.clone());
        let next = checked_add(current, amount)?;
        env.storage()
            .persistent()
            .set(&DataKey::BadDebt(asset), &next);
        Ok(next)
    }

    pub fn balance_of(env: Env, asset: Address) -> i128 {
        balance_of(env, asset)
    }

    pub fn bad_debt_of(env: Env, asset: Address) -> i128 {
        bad_debt_of(env, asset)
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

fn require_liquidation(env: &Env) -> Result<Address, CoreError> {
    let liquidation: Address = env
        .storage()
        .instance()
        .get(&DataKey::Liquidation)
        .ok_or(CoreError::InvalidConfig)?;
    liquidation.require_auth();
    Ok(liquidation)
}

fn balance_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(asset))
        .unwrap_or(0)
}

fn bad_debt_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::BadDebt(asset))
        .unwrap_or(0)
}

fn increase_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_add(balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(asset.clone()), &next);
    Ok(next)
}

fn decrease_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_sub(balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(asset.clone()), &next);
    Ok(next)
}
