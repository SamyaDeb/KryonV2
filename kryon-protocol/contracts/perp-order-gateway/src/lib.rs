#![no_std]
#![deny(unsafe_code)]

use protocol_core::{checked_add, CoreError, MarginMode, Position};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Engine,
    Operator,
    Filled(Address, u64),
    Cancelled(Address, u64),
    Paused,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub owner: Address,
    pub market_id: u32,
    pub is_long: bool,
    pub size: i128,
    pub limit_price: i128,
    pub reduce_only: bool,
    pub nonce: u64,
    pub expiry_ts: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchedFill {
    pub maker: Order,
    pub taker: Order,
    pub fill_size: i128,
    pub fill_price: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FillReceipt {
    pub maker_owner: Address,
    pub taker_owner: Address,
    pub market_id: u32,
    pub fill_size: i128,
    pub fill_price: i128,
    pub maker_filled: i128,
    pub taker_filled: i128,
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
pub struct PerpOrderGatewayContract;

#[contractimpl]
impl PerpOrderGatewayContract {
    pub fn initialize(env: Env, admin: Address, engine: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn set_engine(env: Env, engine: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    /// Set the matcher operator authorized to submit settle_fill transactions.
    /// Maker and taker still authorize their exact order intents with Soroban
    /// auth entries, so the operator cannot invent or mutate user orders.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Operator, &operator);
        Ok(())
    }

    pub fn operator(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Operator)
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

    pub fn cancel_order(env: Env, owner: Address, nonce: u64) -> Result<(), CoreError> {
        owner.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Cancelled(owner, nonce), &true);
        Ok(())
    }

    pub fn settle_fill(env: Env, fill: MatchedFill) -> Result<FillReceipt, CoreError> {
        require_not_paused(&env)?;
        require_operator(&env)?;
        require_order_auth(&env, Symbol::new(&env, "maker"), &fill.maker);
        require_order_auth(&env, Symbol::new(&env, "taker"), &fill.taker);
        validate_fill(&env, &fill)?;

        settle_user_side(
            &env,
            &fill.maker.owner,
            fill.maker.market_id,
            fill.maker.is_long,
            fill.maker.reduce_only,
            fill.fill_size,
            fill.fill_price,
        )?;
        engine_charge_trade_fee(
            &env,
            &fill.maker.owner,
            fill.maker.market_id,
            fill.fill_size,
            fill.fill_price,
            true,
        )?;
        settle_user_side(
            &env,
            &fill.taker.owner,
            fill.taker.market_id,
            fill.taker.is_long,
            fill.taker.reduce_only,
            fill.fill_size,
            fill.fill_price,
        )?;
        engine_charge_trade_fee(
            &env,
            &fill.taker.owner,
            fill.taker.market_id,
            fill.fill_size,
            fill.fill_price,
            false,
        )?;

        let maker_filled = add_filled(&env, &fill.maker.owner, fill.maker.nonce, fill.fill_size)?;
        let taker_filled = add_filled(&env, &fill.taker.owner, fill.taker.nonce, fill.fill_size)?;

        Ok(FillReceipt {
            maker_owner: fill.maker.owner,
            taker_owner: fill.taker.owner,
            market_id: fill.maker.market_id,
            fill_size: fill.fill_size,
            fill_price: fill.fill_price,
            maker_filled,
            taker_filled,
        })
    }

    pub fn filled(env: Env, owner: Address, nonce: u64) -> i128 {
        filled(&env, &owner, nonce)
    }

    pub fn is_cancelled(env: Env, owner: Address, nonce: u64) -> bool {
        is_cancelled(&env, &owner, nonce)
    }

    // --- H4: Emergency pause ---

    pub fn emergency_pause(env: Env) -> Result<(), CoreError> {
        require_admin(&env)?;
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

fn require_operator(env: &Env) -> Result<Address, CoreError> {
    let operator: Address = env
        .storage()
        .instance()
        .get(&DataKey::Operator)
        .ok_or(CoreError::Unauthorized)?;
    operator.require_auth();
    Ok(operator)
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

fn require_order_auth(env: &Env, role: Symbol, order: &Order) {
    let args: Vec<Val> = vec![
        env,
        Symbol::new(env, "settle_fill").into_val(env),
        role.into_val(env),
        order.market_id.into_val(env),
        order.is_long.into_val(env),
        order.size.into_val(env),
        order.limit_price.into_val(env),
        order.reduce_only.into_val(env),
        order.nonce.into_val(env),
        order.expiry_ts.into_val(env),
    ];
    order.owner.require_auth_for_args(args);
}

fn engine_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Engine)
        .ok_or(CoreError::InvalidConfig)
}

fn validate_fill(env: &Env, fill: &MatchedFill) -> Result<(), CoreError> {
    if fill.fill_size <= 0 || fill.fill_price <= 0 {
        return Err(CoreError::InvalidAmount);
    }
    if fill.maker.owner == fill.taker.owner {
        return Err(CoreError::SelfTrade);
    }
    if fill.maker.market_id == 0 || fill.maker.market_id != fill.taker.market_id {
        return Err(CoreError::InvalidConfig);
    }
    if fill.maker.is_long == fill.taker.is_long {
        return Err(CoreError::DirectionMismatch);
    }
    validate_order(env, &fill.maker, fill.fill_size, fill.fill_price)?;
    validate_order(env, &fill.taker, fill.fill_size, fill.fill_price)?;
    Ok(())
}

fn validate_order(
    env: &Env,
    order: &Order,
    fill_size: i128,
    fill_price: i128,
) -> Result<(), CoreError> {
    if order.size <= 0 || order.limit_price <= 0 {
        return Err(CoreError::InvalidAmount);
    }
    if env.ledger().timestamp() > order.expiry_ts {
        return Err(CoreError::OrderExpired);
    }
    if is_cancelled(env, &order.owner, order.nonce) {
        return Err(CoreError::OrderCancelled);
    }
    if checked_add(filled(env, &order.owner, order.nonce), fill_size)? > order.size {
        return Err(CoreError::OrderOverfilled);
    }
    if order.is_long && fill_price > order.limit_price {
        return Err(CoreError::PriceOutsideBand);
    }
    if !order.is_long && fill_price < order.limit_price {
        return Err(CoreError::PriceOutsideBand);
    }
    Ok(())
}

fn settle_user_side(
    env: &Env,
    owner: &Address,
    market_id: u32,
    is_long: bool,
    reduce_only: bool,
    fill_size: i128,
    fill_price: i128,
) -> Result<(), CoreError> {
    let positions = engine_positions(env, owner)?;
    let mut opposite: Option<Position> = None;
    let mut same: Option<Position> = None;
    for position in positions.iter() {
        if position.market_id != market_id {
            continue;
        }
        if position.is_long == is_long {
            same = Some(position);
        } else {
            opposite = Some(position);
        }
    }

    if let Some(position) = opposite {
        let close_size = core::cmp::min(position.size, fill_size);
        engine_reduce_position(env, owner, position.position_id, close_size, fill_price)?;
        let residual = fill_size - close_size;
        if residual > 0 {
            if reduce_only {
                return Err(CoreError::InvalidAmount);
            }
            engine_open_position(env, owner, market_id, residual, is_long, fill_price)?;
        }
        return Ok(());
    }

    if reduce_only {
        return Err(CoreError::PositionNotFound);
    }
    if let Some(position) = same {
        engine_increase_position(env, owner, position.position_id, fill_size, fill_price)?;
    } else {
        engine_open_position(env, owner, market_id, fill_size, is_long, fill_price)?;
    }
    Ok(())
}

fn engine_positions(env: &Env, user: &Address) -> Result<Vec<Position>, CoreError> {
    Ok(env.invoke_contract::<Vec<Position>>(
        &engine_address(env)?,
        &Symbol::new(env, "positions"),
        vec![env, user.into_val(env)],
    ))
}

fn engine_open_position(
    env: &Env,
    user: &Address,
    market_id: u32,
    size: i128,
    is_long: bool,
    execution_price: i128,
) -> Result<(), CoreError> {
    let _: EngineTradeResult = env.invoke_contract(
        &engine_address(env)?,
        &Symbol::new(env, "open_position"),
        vec![
            env,
            user.into_val(env),
            market_id.into_val(env),
            size.into_val(env),
            is_long.into_val(env),
            execution_price.into_val(env),
            MarginMode::Cross.into_val(env),
        ],
    );
    Ok(())
}

fn engine_increase_position(
    env: &Env,
    user: &Address,
    position_id: u64,
    size: i128,
    execution_price: i128,
) -> Result<(), CoreError> {
    let _: EngineTradeResult = env.invoke_contract(
        &engine_address(env)?,
        &Symbol::new(env, "increase_position"),
        vec![
            env,
            user.into_val(env),
            position_id.into_val(env),
            size.into_val(env),
            execution_price.into_val(env),
        ],
    );
    Ok(())
}

fn engine_reduce_position(
    env: &Env,
    user: &Address,
    position_id: u64,
    size: i128,
    execution_price: i128,
) -> Result<(), CoreError> {
    let _: EngineTradeResult = env.invoke_contract(
        &engine_address(env)?,
        &Symbol::new(env, "reduce_position"),
        vec![
            env,
            user.into_val(env),
            position_id.into_val(env),
            size.into_val(env),
            execution_price.into_val(env),
        ],
    );
    Ok(())
}

fn engine_charge_trade_fee(
    env: &Env,
    user: &Address,
    market_id: u32,
    size: i128,
    execution_price: i128,
    is_maker: bool,
) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &engine_address(env)?,
        &Symbol::new(env, "charge_trade_fee"),
        vec![
            env,
            user.into_val(env),
            market_id.into_val(env),
            size.into_val(env),
            execution_price.into_val(env),
            is_maker.into_val(env),
        ],
    )
}

fn filled(env: &Env, owner: &Address, nonce: u64) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Filled(owner.clone(), nonce))
        .unwrap_or(0)
}

fn add_filled(env: &Env, owner: &Address, nonce: u64, amount: i128) -> Result<i128, CoreError> {
    let next = checked_add(filled(env, owner, nonce), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Filled(owner.clone(), nonce), &next);
    Ok(next)
}

fn is_cancelled(env: &Env, owner: &Address, nonce: u64) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Cancelled(owner.clone(), nonce))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_engine::{
        EngineMarketConfig, FeeConfig, PerpEngineContract, PerpEngineContractClient,
    };
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use perp_vault::{PerpVaultContract, PerpVaultContractClient};
    use protocol_core::{MarketConfig, OracleGuard, OracleSource, PRECISION};
    use soroban_sdk::{testutils::Address as _, token, Address, Env, Symbol};

    struct Setup<'a> {
        env: Env,
        admin: Address,
        maker: Address,
        taker: Address,
        settlement_asset: Address,
        vault: PerpVaultContractClient<'a>,
        gateway: PerpOrderGatewayContractClient<'a>,
        engine: PerpEngineContractClient<'a>,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let publisher = Address::generate(&env);
        let settlement_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        let token_admin = token::StellarAssetClient::new(&env, &settlement_asset);
        token_admin.mint(&maker, &(10_000 * PRECISION));
        token_admin.mint(&taker, &(10_000 * PRECISION));

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
        let gateway_id = env.register(PerpOrderGatewayContract, ());
        let vault = PerpVaultContractClient::new(&env, &vault_id);
        let engine = PerpEngineContractClient::new(&env, &engine_id);
        let gateway = PerpOrderGatewayContractClient::new(&env, &gateway_id);

        vault.initialize(&admin, &oracle_id, &engine_id);
        vault.set_collateral(&settlement_asset, &Symbol::new(&env, "USDC"), &0, &true);
        engine.initialize(&admin, &oracle_id, &vault_id, &settlement_asset);
        engine.set_order_gateway(&gateway_id);
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
        gateway.initialize(&admin, &engine_id);
        gateway.set_operator(&admin);
        engine.set_fee_collector(&gateway_id);
        vault.deposit(&maker, &settlement_asset, &(1_000 * PRECISION));
        vault.deposit(&taker, &settlement_asset, &(1_000 * PRECISION));

        Setup {
            env,
            admin,
            maker,
            taker,
            settlement_asset,
            vault,
            gateway,
            engine,
        }
    }

    fn order(owner: Address, is_long: bool, nonce: u64, env: &Env) -> Order {
        Order {
            owner,
            market_id: 1,
            is_long,
            size: PRECISION,
            limit_price: 100 * PRECISION,
            reduce_only: false,
            nonce,
            expiry_ts: env.ledger().timestamp() + 60,
        }
    }

    #[test]
    fn matched_fill_opens_both_sides_and_tracks_fills() {
        let s = setup();
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        let receipt = s.gateway.settle_fill(&fill);
        assert_eq!(receipt.maker_filled, PRECISION);
        assert_eq!(receipt.taker_filled, PRECISION);
        assert!(!s.engine.positions(&s.maker).get(0).unwrap().is_long);
        assert!(s.engine.positions(&s.taker).get(0).unwrap().is_long);
    }

    #[test]
    fn rejects_overfill_replay() {
        let s = setup();
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        s.gateway.settle_fill(&fill);
        assert!(s.gateway.try_settle_fill(&fill).is_err());
    }

    #[test]
    fn cancelled_order_cannot_fill() {
        let s = setup();
        s.gateway.cancel_order(&s.maker, &1);
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        assert!(s.gateway.try_settle_fill(&fill).is_err());
        assert!(s.gateway.is_cancelled(&s.maker, &1));
    }

    #[test]
    fn matched_fill_charges_maker_and_taker_fees() {
        let s = setup();
        s.engine.set_fee_config(
            &1,
            &FeeConfig {
                maker_fee_bps: 1,
                taker_fee_bps: 5,
            },
        );
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };

        s.gateway.settle_fill(&fill);

        assert_eq!(
            s.vault.balance_of(&s.maker, &s.settlement_asset),
            (1_000 * PRECISION) - (PRECISION / 100)
        );
        assert_eq!(
            s.vault.balance_of(&s.taker, &s.settlement_asset),
            (1_000 * PRECISION) - (PRECISION / 20)
        );
        assert_eq!(
            s.vault.balance_of(&s.admin, &s.settlement_asset),
            (PRECISION / 100) + (PRECISION / 20)
        );
    }

    // --- H4 gateway pause test ---

    #[test]
    fn paused_gateway_rejects_settle_fill() {
        let s = setup();
        s.gateway.emergency_pause();
        assert!(s.gateway.is_paused());
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        assert!(s.gateway.try_settle_fill(&fill).is_err());
    }
}
