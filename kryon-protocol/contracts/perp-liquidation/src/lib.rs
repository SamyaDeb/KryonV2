#![no_std]
#![deny(unsafe_code)]

use protocol_core::{apply_bps, CoreError};
use risk_engine::AccountHealth;
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Engine,
    Vault,
    Insurance,
    SettlementAsset,
    MaxRewardBps,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationReceipt {
    pub user: Address,
    pub liquidator: Address,
    pub position_id: u64,
    pub close_size: i128,
    pub realized_pnl: i128,
    pub reward: i128,
    pub health_before: AccountHealth,
    pub health_after: AccountHealth,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTradeResult {
    pub position_id: u64,
    pub remaining_size: i128,
    pub entry_price: i128,
    pub realized_pnl: i128,
    pub funding_pnl: i128,
    pub execution_price: i128,
    pub account_equity: i128,
}

#[contract]
pub struct PerpLiquidationContract;

#[contractimpl]
impl PerpLiquidationContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        engine: Address,
        vault: Address,
        insurance: Address,
        settlement_asset: Address,
        max_reward_bps: u32,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        if max_reward_bps > 1_000 {
            return Err(CoreError::InvalidConfig);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Engine, &engine);
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        env.storage()
            .instance()
            .set(&DataKey::SettlementAsset, &settlement_asset);
        env.storage()
            .instance()
            .set(&DataKey::MaxRewardBps, &max_reward_bps);
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

    /// Re-point dependencies after a redeploy. Without these, redeploying the
    /// vault/engine/insurance would strand the liquidation contract on dead
    /// addresses (the values are otherwise only set at `initialize`).
    pub fn set_engine(env: Env, engine: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn set_vault(env: Env, vault: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vault, &vault);
        Ok(())
    }

    pub fn set_insurance(env: Env, insurance: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        Ok(())
    }

    pub fn liquidate(
        env: Env,
        liquidator: Address,
        user: Address,
        position_id: u64,
        close_size: i128,
        execution_price: i128,
    ) -> Result<LiquidationReceipt, CoreError> {
        liquidator.require_auth();
        if liquidator == user {
            return Err(CoreError::Unauthorized);
        }
        if close_size <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }

        let settlement_asset = settlement_asset(&env)?;
        let health_before = vault_health(&env, &user)?;
        if !health_before.liquidatable {
            return Err(CoreError::NotLiquidatable);
        }

        let trade = engine_liquidate_reduce(&env, &user, position_id, close_size, execution_price)?;
        let health_after = vault_health(&env, &user)?;
        let improved = if health_before.equity > 0 && health_after.equity > 0 {
            health_after.margin_ratio > health_before.margin_ratio
        } else {
            health_after.maintenance_margin_required < health_before.maintenance_margin_required
        };
        if !improved {
            return Err(CoreError::LiquidationWouldNotImproveHealth);
        }

        let reward = liquidation_reward(&env, close_size, execution_price)?;
        if reward > 0 {
            insurance_pay_liquidator(&env, &liquidator, &settlement_asset, reward)?;
        }
        // Restore solvency: the vault pulls real tokens from the insurance fund
        // to back any underwater balance and records the uncovered remainder as
        // bad debt. Triggered when the account is underwater post-liquidation.
        if health_after.equity < 0 {
            vault_absorb_bad_debt(&env, &user, &settlement_asset)?;
        }

        Ok(LiquidationReceipt {
            user,
            liquidator,
            position_id,
            close_size,
            realized_pnl: trade.realized_pnl,
            reward,
            health_before,
            health_after,
        })
    }
}

fn engine_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Engine)
        .ok_or(CoreError::InvalidConfig)
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

fn vault_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(CoreError::InvalidConfig)
}

fn insurance_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Insurance)
        .ok_or(CoreError::InvalidConfig)
}

fn settlement_asset(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::SettlementAsset)
        .ok_or(CoreError::InvalidConfig)
}

fn max_reward_bps(env: &Env) -> Result<u32, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::MaxRewardBps)
        .ok_or(CoreError::InvalidConfig)
}

fn vault_health(env: &Env, user: &Address) -> Result<AccountHealth, CoreError> {
    env.invoke_contract::<Result<AccountHealth, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "account_health"),
        vec![
            env,
            user.into_val(env),
            settlement_asset(env)?.into_val(env),
        ],
    )
}

fn liquidation_reward(
    env: &Env,
    close_size: i128,
    execution_price: i128,
) -> Result<i128, CoreError> {
    let notional = protocol_core::mul_precision(close_size, execution_price)?;
    apply_bps(notional, max_reward_bps(env)?)
}

fn engine_liquidate_reduce(
    env: &Env,
    user: &Address,
    position_id: u64,
    close_size: i128,
    execution_price: i128,
) -> Result<EngineTradeResult, CoreError> {
    env.invoke_contract::<Result<EngineTradeResult, CoreError>>(
        &engine_address(env)?,
        &Symbol::new(env, "liquidate_reduce"),
        vec![
            env,
            user.into_val(env),
            position_id.into_val(env),
            close_size.into_val(env),
            execution_price.into_val(env),
        ],
    )
}

fn insurance_pay_liquidator(
    env: &Env,
    liquidator: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "pay_liquidator"),
        vec![
            env,
            liquidator.into_val(env),
            asset.into_val(env),
            amount.into_val(env),
        ],
    )
}

fn vault_absorb_bad_debt(env: &Env, user: &Address, asset: &Address) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "absorb_bad_debt"),
        vec![env, user.into_val(env), asset.into_val(env)],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_engine::{EngineMarketConfig, PerpEngineContract, PerpEngineContractClient};
    use perp_insurance::{PerpInsuranceContract, PerpInsuranceContractClient};
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use perp_vault::{PerpVaultContract, PerpVaultContractClient};
    use protocol_core::{MarginMode, MarketConfig, OracleGuard, OracleSource, PRECISION};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env, Symbol,
    };

    struct Setup<'a> {
        env: Env,
        user: Address,
        liquidator: Address,
        publisher: Address,
        settlement_asset: Address,
        oracle: OracleAdapterContractClient<'a>,
        vault: PerpVaultContractClient<'a>,
        engine: PerpEngineContractClient<'a>,
        insurance: PerpInsuranceContractClient<'a>,
        liquidation: PerpLiquidationContractClient<'a>,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let liquidator = Address::generate(&env);
        let publisher = Address::generate(&env);
        let settlement_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        token::StellarAssetClient::new(&env, &settlement_asset).mint(&user, &(10_000 * PRECISION));
        token::StellarAssetClient::new(&env, &settlement_asset).mint(&admin, &(10_000 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);
        for asset in [Symbol::new(&env, "USDC"), Symbol::new(&env, "BTC")] {
            oracle.set_feed(
                &asset,
                &publisher,
                &OracleSource::Reflector,
                &OracleGuard {
                    max_age_secs: 60,
                    max_confidence_bps: 100,
                },
                &true,
            );
        }
        oracle.write_price(
            &Symbol::new(&env, "USDC"),
            &publisher,
            &PRECISION,
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );
        oracle.write_price(
            &Symbol::new(&env, "BTC"),
            &publisher,
            &(100 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        let engine_id = env.register(PerpEngineContract, ());
        let vault_id = env.register(PerpVaultContract, ());
        let insurance_id = env.register(PerpInsuranceContract, ());
        let liquidation_id = env.register(PerpLiquidationContract, ());

        let vault = PerpVaultContractClient::new(&env, &vault_id);
        let engine = PerpEngineContractClient::new(&env, &engine_id);
        let insurance = PerpInsuranceContractClient::new(&env, &insurance_id);
        let liquidation = PerpLiquidationContractClient::new(&env, &liquidation_id);

        vault.initialize(&admin, &oracle_id, &engine_id);
        vault.set_collateral(&settlement_asset, &Symbol::new(&env, "USDC"), &0, &true);
        vault.set_insurance(&insurance_id);
        vault.set_liquidation(&liquidation_id);
        engine.initialize(&admin, &oracle_id, &vault_id, &settlement_asset);
        engine.set_order_gateway(&admin);
        engine.set_liquidation(&liquidation_id);
        engine.set_market(&EngineMarketConfig {
            market: MarketConfig {
                market_id: 1,
                base_asset: Symbol::new(&env, "BTC"),
                settlement_asset: settlement_asset.clone(),
                max_leverage_bps: 100_000,
                initial_margin_bps: 1_000,
                maintenance_margin_bps: 500,
                liquidation_fee_bps: 50,
                max_open_interest: 1_000 * PRECISION,
                max_oracle_age_secs: 60,
                max_oracle_confidence_bps: 100,
                active: true,
            },
            max_execution_deviation_bps: 100,
        });
        insurance.initialize(&admin, &liquidation_id);
        insurance.set_vault(&vault_id);
        insurance.deposit(&admin, &settlement_asset, &(1_000 * PRECISION));
        liquidation.initialize(
            &admin,
            &engine_id,
            &vault_id,
            &insurance_id,
            &settlement_asset,
            &50,
        );
        vault.deposit(&user, &settlement_asset, &(1_000 * PRECISION));

        Setup {
            env,
            user,
            liquidator,
            publisher,
            settlement_asset,
            oracle,
            vault,
            engine,
            insurance,
            liquidation,
        }
    }

    #[test]
    fn cannot_liquidate_healthy_account() {
        let s = setup();
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        let result = s.liquidation.try_liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(PRECISION / 2),
            &(100 * PRECISION),
        );
        assert!(result.is_err());
    }

    #[test]
    fn liquidates_unhealthy_account_and_pays_reward() {
        let s = setup();
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(100 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|ledger| {
            ledger.timestamp += 1;
        });
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        let receipt = s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(50 * PRECISION),
            &(10 * PRECISION),
        );
        assert!(receipt.health_before.liquidatable);
        assert!(
            receipt.health_after.maintenance_margin_required
                < receipt.health_before.maintenance_margin_required
        );
        assert_eq!(
            s.engine.positions(&s.user).get(0).unwrap().size,
            50 * PRECISION
        );
        assert_eq!(
            token::Client::new(&s.env, &s.settlement_asset).balance(&s.liquidator),
            receipt.reward
        );
        assert!(s.insurance.balance_of(&s.settlement_asset) < 1_000 * PRECISION);
        assert!(s.vault.account_health(&s.user, &s.settlement_asset).equity < 1_000 * PRECISION);
    }

    // C1 solvency: when liquidation drives a balance negative, the vault must pull
    // real tokens from the insurance fund and credit the account back toward zero.
    #[test]
    fn bad_debt_fully_covered_by_insurance_restores_zero_balance() {
        let s = setup(); // insurance funded with 1_000 * PRECISION
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(20 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        // Full close: realized loss 20*(10-100) = -1800 → balance 1000-1800 = -800.
        s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(20 * PRECISION),
            &(10 * PRECISION),
        );

        // Insurance covered the 800 deficit in full: balance back to 0, no bad debt.
        assert_eq!(s.vault.balance_of(&s.user, &s.settlement_asset), 0);
        assert_eq!(s.insurance.bad_debt_of(&s.settlement_asset), 0);
        // Fund paid the 1*PRECISION reward + 800 deficit out of 1_000.
        assert_eq!(
            s.insurance.balance_of(&s.settlement_asset),
            1_000 * PRECISION - PRECISION - 800 * PRECISION
        );
    }

    // C1 solvency: when the fund cannot fully cover, it is drained and the
    // uncovered remainder is recorded as protocol bad debt.
    #[test]
    fn bad_debt_exceeding_fund_is_partially_covered_and_recorded() {
        let s = setup(); // insurance funded with 1_000 * PRECISION
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(100 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        // Full close: realized -9000 → balance -8000. Reward 5 leaves fund at 995,
        // which fully drains covering 995 of the 8000 deficit.
        s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(100 * PRECISION),
            &(10 * PRECISION),
        );

        assert_eq!(s.insurance.balance_of(&s.settlement_asset), 0);
        assert_eq!(
            s.insurance.bad_debt_of(&s.settlement_asset),
            8_000 * PRECISION - 995 * PRECISION
        );
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            -(8_000 * PRECISION) + 995 * PRECISION
        );
    }
}
