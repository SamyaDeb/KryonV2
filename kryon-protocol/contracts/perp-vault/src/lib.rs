#![no_std]
#![deny(unsafe_code)]

use protocol_core::{
    checked_add, checked_sub, CollateralBalance, CollateralConfig, CoreError, MarketConfig,
    MarketSnapshot, OracleGuard, OracleSnapshot, Position,
};
use risk_engine::{account_health, validate_withdrawal, AccountHealth};
use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Env, IntoVal, Map, Symbol, Vec,
};

/// Instance TTL keepalive bounds (ledgers, ~5s each).
const INSTANCE_TTL_THRESHOLD: u32 = 241_920; // ~14 days
                                             // ~30 days: extending instance TTL also extends the contract CODE entry, so
                                             // longer windows on large WASMs exceed the u32 transaction-fee cap (~429 XLM).
                                             // With a 14-day threshold this is a no-op most ticks and one paid bump every
                                             // ~2 weeks.
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    /// Fast-path pause authority. Once governance (48h timelock) is the
    /// admin, an admin-gated emergency_pause is useless in an emergency —
    /// the guardian can PAUSE instantly, but only the admin can unpause.
    Guardian,
    Engine,
    Oracle,
    Insurance,
    Liquidation,
    Collateral(Address),
    Balance(Address, Address),
    Positions(Address),
    MarketConfig(u32),
    FundingLong(u32),
    FundingShort(u32),
    UserAssets(Address),
    Paused,
    /// Per-asset gross-deposit cap for staged launches (0 / absent = uncapped).
    DepositCap(Address),
    /// Running sum of deposits minus withdrawals per asset (backs the cap).
    TotalDeposited(Address),
}

#[contract]
pub struct PerpVaultContract;

#[contractimpl]
impl PerpVaultContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        engine: Address,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn set_oracle(env: Env, oracle: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Oracle, &oracle);
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

    /// Permissionless instance-TTL keepalive — prevents the vault instance
    /// (collateral configs, balances keys) from being archived.
    pub fn extend_instance_ttl(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    pub fn set_engine(env: Env, engine: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn set_guardian(env: Env, guardian: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        Ok(())
    }

    pub fn guardian(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Guardian)
    }

    /// Per-asset gross-deposit cap for staged rollouts. cap <= 0 removes it.
    pub fn set_deposit_cap(env: Env, asset: Address, cap: i128) -> Result<(), CoreError> {
        require_admin(&env)?;
        if cap <= 0 {
            env.storage().instance().remove(&DataKey::DepositCap(asset));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::DepositCap(asset), &cap);
        }
        Ok(())
    }

    pub fn deposit_cap(env: Env, asset: Address) -> Option<i128> {
        env.storage().instance().get(&DataKey::DepositCap(asset))
    }

    pub fn total_deposited(env: Env, asset: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposited(asset))
            .unwrap_or(0)
    }

    pub fn set_insurance(env: Env, insurance: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        Ok(())
    }

    pub fn set_liquidation(env: Env, liquidation: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    /// Absorb an underwater account's bad debt after liquidation. The vault pulls
    /// real tokens from the insurance fund into reserves and credits the user back
    /// toward zero. Any uncovered remainder is recorded as protocol bad debt.
    /// Returns the amount covered. Idempotent for non-negative balances (returns 0).
    /// Only the liquidation contract may call.
    pub fn absorb_bad_debt(env: Env, user: Address, asset: Address) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        let balance = balance_of(env.clone(), user.clone(), asset.clone());
        if balance >= 0 {
            return Ok(0);
        }
        let deficit = checked_sub(0, balance)?;
        let covered = insurance_cover_deficit(&env, &asset, deficit)?;
        if covered > 0 {
            increase_balance(&env, &user, &asset, covered)?;
        }
        let remaining = checked_sub(deficit, covered)?;
        if remaining > 0 {
            insurance_record_bad_debt(&env, &asset, remaining)?;
        }
        Ok(covered)
    }

    pub fn set_collateral(
        env: Env,
        asset: Address,
        oracle_asset: Symbol,
        haircut_bps: u32,
        active: bool,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        if haircut_bps > 10_000 {
            return Err(CoreError::InvalidConfig);
        }
        let config = CollateralConfig {
            asset: asset.clone(),
            oracle_asset,
            haircut_bps,
            active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Collateral(asset), &config);
        Ok(())
    }

    pub fn set_market_config(env: Env, config: MarketConfig) -> Result<(), CoreError> {
        require_admin(&env)?;
        validate_market_config(&config)?;
        env.storage()
            .persistent()
            .set(&DataKey::MarketConfig(config.market_id), &config);
        Ok(())
    }

    pub fn set_funding_indexes(
        env: Env,
        market_id: u32,
        funding_index_long: i128,
        funding_index_short: i128,
    ) -> Result<(), CoreError> {
        require_engine(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FundingLong(market_id), &funding_index_long);
        env.storage()
            .persistent()
            .set(&DataKey::FundingShort(market_id), &funding_index_short);
        Ok(())
    }

    pub fn sync_positions(
        env: Env,
        user: Address,
        positions: Vec<Position>,
    ) -> Result<(), CoreError> {
        require_engine(&env)?;
        for position in positions.iter() {
            if position.owner != user {
                return Err(CoreError::Unauthorized);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::Positions(user), &positions);
        Ok(())
    }

    pub fn apply_pnl(
        env: Env,
        user: Address,
        asset: Address,
        pnl: i128,
    ) -> Result<i128, CoreError> {
        require_engine(&env)?;
        require_not_paused(&env)?;
        if pnl >= 0 {
            increase_balance(&env, &user, &asset, pnl)
        } else {
            decrease_balance(&env, &user, &asset, checked_sub(0, pnl)?)
        }
    }

    pub fn deposit(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        require_not_paused(&env)?;
        user.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let config = load_collateral(&env, &asset)?;
        if !config.active {
            return Err(CoreError::AssetDisabled);
        }
        // Staged-launch TVL cap: gross deposits (net of withdrawals) per asset.
        let total = Self::total_deposited(env.clone(), asset.clone());
        let next_total = checked_add(total, amount)?;
        if let Some(cap) = Self::deposit_cap(env.clone(), asset.clone()) {
            if next_total > cap {
                return Err(CoreError::DepositCapExceeded);
            }
        }
        let vault = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&user, &vault, &amount);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited(asset.clone()), &next_total);
        let new_balance = increase_balance(&env, &user, &asset, amount)?;
        record_user_asset(&env, &user, &asset);
        Ok(new_balance)
    }

    pub fn withdraw(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
    ) -> Result<AccountHealth, CoreError> {
        require_not_paused(&env)?;
        user.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let config = load_collateral(&env, &asset)?;
        if !config.active {
            return Err(CoreError::AssetDisabled);
        }
        let balance = balance_of(env.clone(), user.clone(), asset.clone());
        if balance < amount {
            return Err(CoreError::InsufficientCollateral);
        }

        let positions = load_positions(&env, &user);
        let user_assets_key = DataKey::UserAssets(user.clone());
        let account = if env.storage().persistent().has(&user_assets_key) {
            account_snapshot_all_assets(&env, user.clone(), positions)?
        } else {
            account_snapshot_for_asset(
                &env,
                user.clone(),
                asset.clone(),
                balance,
                config,
                positions,
            )?
        };
        let markets = load_markets_for_positions(&env, &account.positions)?;
        let price = collateral_price(&env, &asset)?;
        let withdrawal_value = protocol_core::mul_precision(amount, price.price)?;
        let health = validate_withdrawal(&env, &account, &markets, withdrawal_value)?;

        decrease_balance(&env, &user, &asset, amount)?;
        // Free cap headroom (saturating: pre-upgrade deposits were never counted).
        let total = Self::total_deposited(env.clone(), asset.clone());
        env.storage().instance().set(
            &DataKey::TotalDeposited(asset.clone()),
            &core::cmp::max(0, total - amount),
        );
        let vault = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&vault, &user, &amount);
        Ok(health)
    }

    pub fn account_health(
        env: Env,
        user: Address,
        asset: Address,
    ) -> Result<AccountHealth, CoreError> {
        let positions = load_positions(&env, &user);
        let user_assets_key = DataKey::UserAssets(user.clone());
        let account = if env.storage().persistent().has(&user_assets_key) {
            account_snapshot_all_assets(&env, user, positions)?
        } else {
            let config = load_collateral(&env, &asset)?;
            let balance = balance_of(env.clone(), user.clone(), asset.clone());
            account_snapshot_for_asset(&env, user, asset, balance, config, positions)?
        };
        let markets = load_markets_for_positions(&env, &account.positions)?;
        account_health(&env, &account, &markets)
    }

    pub fn balance_of(env: Env, user: Address, asset: Address) -> i128 {
        balance_of(env, user, asset)
    }

    // --- H4: Emergency pause ---

    /// Pause deposits/withdrawals/PnL. Callable by the admin OR the guardian —
    /// the guardian is the fast path once admin sits behind the governance
    /// timelock. Unpause remains admin-only, so a compromised guardian can
    /// halt the system but never restart it.
    pub fn emergency_pause(env: Env, caller: Address) -> Result<(), CoreError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CoreError::InvalidConfig)?;
        let guardian: Option<Address> = env.storage().instance().get(&DataKey::Guardian);
        if caller != admin && Some(caller) != guardian {
            return Err(CoreError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().remove(&DataKey::Paused);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
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

fn require_engine(env: &Env) -> Result<Address, CoreError> {
    let engine: Address = env
        .storage()
        .instance()
        .get(&DataKey::Engine)
        .ok_or(CoreError::InvalidConfig)?;
    engine.require_auth();
    Ok(engine)
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

fn insurance_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Insurance)
        .ok_or(CoreError::InvalidConfig)
}

fn insurance_cover_deficit(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "cover_deficit"),
        vec![env, asset.into_val(env), amount.into_val(env)],
    )
}

fn insurance_record_bad_debt(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "record_bad_debt"),
        vec![env, asset.into_val(env), amount.into_val(env)],
    )
}

fn require_not_paused(env: &Env) -> Result<(), CoreError> {
    if env
        .storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::Paused)
        .unwrap_or(false)
    {
        return Err(CoreError::Unauthorized);
    }
    Ok(())
}

fn validate_market_config(config: &MarketConfig) -> Result<(), CoreError> {
    if config.market_id == 0
        || config.initial_margin_bps == 0
        || config.maintenance_margin_bps == 0
        || config.maintenance_margin_bps > config.initial_margin_bps
        || config.max_leverage_bps == 0
        || config.max_oracle_age_secs == 0
        || config.max_oracle_confidence_bps > 10_000
        || config.max_open_interest <= 0
    {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn load_collateral(env: &Env, asset: &Address) -> Result<CollateralConfig, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Collateral(asset.clone()))
        .ok_or(CoreError::InvalidConfig)
}

fn balance_of(env: Env, user: Address, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(user, asset))
        .unwrap_or(0)
}

fn load_positions(env: &Env, user: &Address) -> Vec<Position> {
    env.storage()
        .persistent()
        .get(&DataKey::Positions(user.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn increase_balance(
    env: &Env,
    user: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    let current = balance_of(env.clone(), user.clone(), asset.clone());
    let next = checked_add(current, amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(user.clone(), asset.clone()), &next);
    Ok(next)
}

fn decrease_balance(
    env: &Env,
    user: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    let current = balance_of(env.clone(), user.clone(), asset.clone());
    let next = checked_sub(current, amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(user.clone(), asset.clone()), &next);
    Ok(next)
}

fn oracle_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(CoreError::InvalidConfig)
}

fn oracle_get_price(
    env: &Env,
    oracle: &Address,
    asset: &Symbol,
    guard: Option<OracleGuard>,
) -> Result<OracleSnapshot, CoreError> {
    env.invoke_contract::<Result<OracleSnapshot, CoreError>>(
        oracle,
        &Symbol::new(env, "get_price"),
        vec![env, asset.into_val(env), guard.into_val(env)],
    )
}

fn collateral_price(
    env: &Env,
    asset: &Address,
) -> Result<protocol_core::OracleSnapshot, CoreError> {
    let config = load_collateral(env, asset)?;
    oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)
}

fn account_snapshot_for_asset(
    env: &Env,
    user: Address,
    asset: Address,
    amount: i128,
    config: CollateralConfig,
    positions: Vec<Position>,
) -> Result<protocol_core::AccountSnapshot, CoreError> {
    let price = oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)?;
    let value = protocol_core::mul_precision(amount, price.price)?;
    let collateral = Vec::from_array(
        env,
        [CollateralBalance {
            asset,
            amount,
            value,
            haircut_bps: config.haircut_bps,
        }],
    );
    for position in positions.iter() {
        if position.owner != user {
            return Err(CoreError::Unauthorized);
        }
    }
    Ok(protocol_core::AccountSnapshot {
        owner: user,
        collateral,
        positions,
    })
}

// --- H6: Multi-collateral helpers ---

fn record_user_asset(env: &Env, user: &Address, asset: &Address) {
    let key = DataKey::UserAssets(user.clone());
    let mut assets: Vec<Address> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    for a in assets.iter() {
        if a == *asset {
            return;
        }
    }
    assets.push_back(asset.clone());
    env.storage().persistent().set(&key, &assets);
}

fn account_snapshot_all_assets(
    env: &Env,
    user: Address,
    positions: Vec<Position>,
) -> Result<protocol_core::AccountSnapshot, CoreError> {
    let user_assets_key = DataKey::UserAssets(user.clone());
    let user_assets: Vec<Address> = env
        .storage()
        .persistent()
        .get(&user_assets_key)
        .unwrap_or_else(|| Vec::new(env));

    let mut collateral: Vec<CollateralBalance> = Vec::new(env);
    for asset in user_assets.iter() {
        let amount = balance_of(env.clone(), user.clone(), asset.clone());
        // Zero balance contributes nothing — skip to avoid unnecessary oracle calls.
        // Negative balances MUST be included: they represent underwater accounts
        // that need the negative equity to trigger bad-debt coverage.
        if amount == 0 {
            continue;
        }
        let config = match env
            .storage()
            .persistent()
            .get::<DataKey, CollateralConfig>(&DataKey::Collateral(asset.clone()))
        {
            Some(c) => c,
            None => continue,
        };
        if !config.active {
            continue;
        }
        let price = oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)?;
        let value = protocol_core::mul_precision(amount, price.price)?;
        collateral.push_back(CollateralBalance {
            asset,
            amount,
            value,
            haircut_bps: config.haircut_bps,
        });
    }

    for position in positions.iter() {
        if position.owner != user {
            return Err(CoreError::Unauthorized);
        }
    }
    Ok(protocol_core::AccountSnapshot {
        owner: user,
        collateral,
        positions,
    })
}

fn load_markets_for_positions(
    env: &Env,
    positions: &Vec<Position>,
) -> Result<Map<u32, MarketSnapshot>, CoreError> {
    let mut markets = Map::new(env);
    for position in positions.iter() {
        if markets.contains_key(position.market_id) {
            continue;
        }
        let config: MarketConfig = env
            .storage()
            .persistent()
            .get(&DataKey::MarketConfig(position.market_id))
            .ok_or(CoreError::InvalidConfig)?;
        let guard = OracleGuard {
            max_age_secs: config.max_oracle_age_secs,
            max_confidence_bps: config.max_oracle_confidence_bps,
        };
        let oracle_price =
            oracle_get_price(env, &oracle_address(env)?, &config.base_asset, Some(guard))?.price;
        let funding_index_long = env
            .storage()
            .persistent()
            .get(&DataKey::FundingLong(config.market_id))
            .unwrap_or(0);
        let funding_index_short = env
            .storage()
            .persistent()
            .get(&DataKey::FundingShort(config.market_id))
            .unwrap_or(0);
        markets.set(
            config.market_id,
            MarketSnapshot {
                config,
                oracle_price,
                funding_index_long,
                funding_index_short,
            },
        );
    }
    Ok(markets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use protocol_core::{MarginMode, OracleSource, PRECISION};
    use soroban_sdk::{testutils::Address as _, token, Address, Env, Symbol, Vec};

    fn setup(
        env: &Env,
    ) -> (
        Address,
        Address,
        Address,
        Address,
        Address,
        PerpVaultContractClient<'_>,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let user = Address::generate(env);
        let engine = Address::generate(env);
        let publisher = Address::generate(env);
        let settlement_admin = Address::generate(env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        token::StellarAssetClient::new(env, &settlement_asset).mint(&user, &(1_000 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(env, &oracle_id);
        oracle.initialize(&admin);
        oracle.set_feed(
            &Symbol::new(env, "USDC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.set_feed(
            &Symbol::new(env, "BTC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.write_price(
            &Symbol::new(env, "USDC"),
            &publisher,
            &PRECISION,
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );
        oracle.write_price(
            &Symbol::new(env, "BTC"),
            &publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine);
        vault.set_collateral(&settlement_asset, &Symbol::new(env, "USDC"), &0, &true);
        vault.set_market_config(&MarketConfig {
            market_id: 1,
            base_asset: Symbol::new(env, "BTC"),
            settlement_asset: settlement_asset.clone(),
            max_leverage_bps: 100_000,
            initial_margin_bps: 1_000,
            maintenance_margin_bps: 500,
            liquidation_fee_bps: 50,
            max_open_interest: 10_000 * PRECISION,
            max_oracle_age_secs: 60,
            max_oracle_confidence_bps: 100,
            active: true,
        });

        (user, engine, publisher, settlement_asset, oracle_id, vault)
    }

    #[test]
    fn deposit_increases_internal_balance_after_token_transfer() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);

        assert_eq!(
            vault.deposit(&user, &settlement_asset, &(100 * PRECISION)),
            100 * PRECISION
        );
        assert_eq!(vault.balance_of(&user, &settlement_asset), 100 * PRECISION);
    }

    #[test]
    fn withdraw_rejects_unrealized_loss_even_with_token_balance() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        vault.deposit(&user, &settlement_asset, &(1_000 * PRECISION));

        let positions = Vec::from_array(
            &env,
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
        vault.sync_positions(&user, &positions);

        let result = vault.try_withdraw(&user, &settlement_asset, &(100 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn synced_positions_must_belong_to_account_owner() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let other_user = Address::generate(&env);
        let positions = Vec::from_array(
            &env,
            [Position {
                position_id: 1,
                owner: other_user,
                market_id: 1,
                size: PRECISION,
                entry_price: 100 * PRECISION,
                margin: 10 * PRECISION,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            }],
        );
        let result = vault.try_sync_positions(&user, &positions);
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
        assert_eq!(vault.balance_of(&user, &settlement_asset), 0);
    }

    // --- H4 pause tests ---

    #[test]
    fn paused_vault_rejects_deposit() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        assert!(vault.is_paused());
        let result = vault.try_deposit(&user, &settlement_asset, &(100 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn paused_vault_rejects_withdraw() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        // deposit before pause
        vault.deposit(&user, &settlement_asset, &(100 * PRECISION));
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        let result = vault.try_withdraw(&user, &settlement_asset, &(50 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn unpause_restores_deposit() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        assert!(vault.is_paused());
        vault.unpause();
        assert!(!vault.is_paused());
        // deposit should succeed after unpause
        assert_eq!(
            vault.deposit(&user, &settlement_asset, &(100 * PRECISION)),
            100 * PRECISION
        );
    }

    // --- Guardian fast-path pause ---

    #[test]
    fn guardian_can_pause_but_not_unpause_and_stranger_cannot_pause() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let guardian = Address::generate(&env);
        let stranger = Address::generate(&env);
        vault.set_guardian(&guardian);

        // A random address may not pause even with its auth mocked.
        assert!(vault.try_emergency_pause(&stranger).is_err());
        assert!(!vault.is_paused());

        // The guardian pauses instantly.
        vault.emergency_pause(&guardian);
        assert!(vault.is_paused());
        assert!(vault
            .try_deposit(&user, &settlement_asset, &(10 * PRECISION))
            .is_err());

        // Only the admin can unpause (guardian compromise cannot restart).
        vault.unpause();
        assert!(!vault.is_paused());
    }

    // --- Staged-launch deposit cap ---

    #[test]
    fn deposit_cap_blocks_over_cap_and_withdraw_frees_headroom() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);

        vault.set_deposit_cap(&settlement_asset, &(100 * PRECISION));
        assert_eq!(vault.deposit_cap(&settlement_asset), Some(100 * PRECISION));

        vault.deposit(&user, &settlement_asset, &(80 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 80 * PRECISION);

        // 80 + 30 > 100 → rejected; headroom-sized deposit passes.
        assert!(vault
            .try_deposit(&user, &settlement_asset, &(30 * PRECISION))
            .is_err());
        vault.deposit(&user, &settlement_asset, &(20 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 100 * PRECISION);

        // Withdrawals free capacity.
        vault.withdraw(&user, &settlement_asset, &(50 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 50 * PRECISION);
        vault.deposit(&user, &settlement_asset, &(50 * PRECISION));

        // Removing the cap lifts the limit entirely.
        vault.set_deposit_cap(&settlement_asset, &0);
        assert_eq!(vault.deposit_cap(&settlement_asset), None);
        vault.deposit(&user, &settlement_asset, &(500 * PRECISION));
    }

    // --- H6 multi-collateral test ---

    #[test]
    fn multi_collateral_health_includes_all_assets() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let engine = Address::generate(&env);
        let publisher = Address::generate(&env);

        // Create two separate token contracts: one for USDC, one for BTC
        let usdc_admin = Address::generate(&env);
        let btc_admin = Address::generate(&env);
        let usdc_contract = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let btc_contract = env.register_stellar_asset_contract_v2(btc_admin.clone());
        let usdc_asset = usdc_contract.address();
        let btc_asset = btc_contract.address();

        // Mint tokens to user
        token::StellarAssetClient::new(&env, &usdc_asset).mint(&user, &(1_000 * PRECISION));
        token::StellarAssetClient::new(&env, &btc_asset).mint(&user, &(10 * PRECISION));

        // Set up oracle with prices for USDC and BTC
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);
        oracle.set_feed(
            &Symbol::new(&env, "USDC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.set_feed(
            &Symbol::new(&env, "BTC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        // USDC = $1, BTC = $10 (using PRECISION scale)
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
            &(10 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        // Initialize vault with both collateral types
        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(&env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine);
        vault.set_collateral(&usdc_asset, &Symbol::new(&env, "USDC"), &0, &true);
        vault.set_collateral(&btc_asset, &Symbol::new(&env, "BTC"), &0, &true);

        // Deposit both assets
        let usdc_deposit = 100 * PRECISION;
        let btc_deposit = 2 * PRECISION;
        vault.deposit(&user, &usdc_asset, &usdc_deposit);
        vault.deposit(&user, &btc_asset, &btc_deposit);

        // account_health called with USDC address should include BTC value too
        let health = vault.account_health(&user, &usdc_asset);

        // USDC value: 100 * PRECISION * PRECISION / PRECISION = 100 * PRECISION
        // BTC value:   2 * PRECISION * 10 * PRECISION / PRECISION = 20 * PRECISION
        // Total equity (no positions) = 120 * PRECISION
        assert_eq!(health.equity, 120 * PRECISION);
    }
}
