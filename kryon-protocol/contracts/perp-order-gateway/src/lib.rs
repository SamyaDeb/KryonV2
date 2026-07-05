#![no_std]
#![deny(unsafe_code)]

use protocol_core::{checked_add, CoreError, MarginMode, Position};
use soroban_sdk::{
    address_payload::AddressPayload, contract, contractimpl, contracttype, vec, Address, Bytes,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    /// Fast-path pause authority: may pause settlement instantly; only the
    /// admin (governance post-transfer) can unpause.
    Guardian,
    Engine,
    Operator,
    /// Settlement signing domain (the network passphrase bytes). Bound into the
    /// canonical order message so signatures cannot be replayed across networks.
    Domain,
    Filled(Address, u64),
    Cancelled(Address, u64),
    Paused,
}

/// Grace period after an order's expiry before its Filled/Cancelled entries
/// may be reclaimed. Orders past expiry can never fill again (validate_order
/// rejects them), so reclamation after expiry+grace cannot re-enable a replay.
pub const RECLAIM_GRACE_SECS: u64 = 86_400; // 24h

/// Persistent-entry TTL management (values in ledgers, ~5s each).
/// Entries are extended to ~30 days whenever written; anything still live
/// past its order expiry only needs to survive until reclamation.
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const PERSISTENT_TTL_EXTEND_TO: u32 = 518_400; // ~30 days
const INSTANCE_TTL_THRESHOLD: u32 = 241_920; // ~14 days
                                             // ~30 days: extending instance TTL also extends the contract CODE entry, so
                                             // longer windows on large WASMs exceed the u32 transaction-fee cap (~429 XLM).
                                             // With a 14-day threshold this is a no-op most ticks and one paid bump every
                                             // ~2 weeks.
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

/// Per-order fill accounting. Carries the order's expiry so the entry can be
/// safely reclaimed once the order can no longer fill.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilledEntry {
    pub amount: i128,
    pub expiry_ts: u64,
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

    /// Cancel an order by nonce. `expiry_ts` must be the order's real expiry —
    /// it bounds how long the tombstone must be kept before `reclaim_order_state`
    /// may prune it. Supplying an earlier expiry only shortens the caller's own
    /// cancel tombstone (cancel requires the owner's auth), never anyone else's.
    pub fn cancel_order(
        env: Env,
        owner: Address,
        nonce: u64,
        expiry_ts: u64,
    ) -> Result<(), CoreError> {
        owner.require_auth();
        let key = DataKey::Cancelled(owner, nonce);
        env.storage().persistent().set(&key, &expiry_ts);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
        Ok(())
    }

    /// Permissionless pruning of Filled/Cancelled entries for orders that are
    /// past `expiry_ts + RECLAIM_GRACE_SECS`. An expired order can never fill
    /// (validate_order enforces expiry), so removing its entries cannot enable
    /// replay or overfill. Bounds the gateway's otherwise-unbounded persistent
    /// storage growth (audit I1). Returns how many entries were removed.
    pub fn reclaim_order_state(env: Env, owner: Address, nonces: Vec<u64>) -> u32 {
        let now = env.ledger().timestamp();
        let mut removed: u32 = 0;
        for nonce in nonces.iter() {
            let filled_key = DataKey::Filled(owner.clone(), nonce);
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, FilledEntry>(&filled_key)
            {
                if now > entry.expiry_ts.saturating_add(RECLAIM_GRACE_SECS) {
                    env.storage().persistent().remove(&filled_key);
                    removed += 1;
                }
            }
            let cancelled_key = DataKey::Cancelled(owner.clone(), nonce);
            if let Some(expiry_ts) = env
                .storage()
                .persistent()
                .get::<DataKey, u64>(&cancelled_key)
            {
                if now > expiry_ts.saturating_add(RECLAIM_GRACE_SECS) {
                    env.storage().persistent().remove(&cancelled_key);
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Permissionless instance-TTL keepalive. Any keeper may call this to keep
    /// the contract instance (and its config) from being archived.
    pub fn extend_instance_ttl(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// Admin sets the settlement signing domain — the network passphrase bytes.
    /// This is bound into the canonical order message that `settle_fill_signed`
    /// reconstructs and verifies, preventing cross-network signature replay.
    pub fn set_domain(env: Env, domain: Bytes) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Domain, &domain);
        Ok(())
    }

    pub fn domain(env: Env) -> Option<Bytes> {
        env.storage().instance().get(&DataKey::Domain)
    }

    /// Interactive settlement: maker and taker each provide a Soroban auth entry
    /// (collected via the client at fill time). Kept for completeness/back-compat.
    pub fn settle_fill(env: Env, fill: MatchedFill) -> Result<FillReceipt, CoreError> {
        require_not_paused(&env)?;
        require_operator(&env)?;
        require_order_auth(&env, Symbol::new(&env, "maker"), &fill.maker);
        require_order_auth(&env, Symbol::new(&env, "taker"), &fill.taker);
        validate_fill(&env, &fill)?;
        execute_fill(&env, fill)
    }

    /// Autonomous settlement (the primary path): maker and taker signed their
    /// order once at placement (SEP-53 over the canonical order message). The
    /// operator (matcher) submits the matched fill with both ed25519 signatures;
    /// the contract verifies them on-chain — no per-fill wallet interaction.
    ///
    /// Security: each signature commits to the order's market, side, size,
    /// limit price, nonce and expiry. `validate_fill` then enforces the operator
    /// cannot fill beyond the signed size, outside the signed price, after expiry,
    /// or after cancellation — so signing once safely authorizes all fills of
    /// that order.
    pub fn settle_fill_signed(
        env: Env,
        fill: MatchedFill,
        maker_sig: BytesN<64>,
        taker_sig: BytesN<64>,
    ) -> Result<FillReceipt, CoreError> {
        require_not_paused(&env)?;
        require_operator(&env)?;
        verify_order_signature(&env, &fill.maker, &maker_sig)?;
        verify_order_signature(&env, &fill.taker, &taker_sig)?;
        validate_fill(&env, &fill)?;
        execute_fill(&env, fill)
    }

    pub fn filled(env: Env, owner: Address, nonce: u64) -> i128 {
        filled(&env, &owner, nonce)
    }

    pub fn is_cancelled(env: Env, owner: Address, nonce: u64) -> bool {
        is_cancelled(&env, &owner, nonce)
    }

    // --- H4: Emergency pause ---

    pub fn set_guardian(env: Env, guardian: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        Ok(())
    }

    pub fn guardian(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Guardian)
    }

    /// Pause settlement. Callable by the admin OR the guardian — the guardian
    /// is the fast path once admin sits behind the governance timelock.
    /// Unpause remains admin-only.
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

/// Shared settlement body for both `settle_fill` and `settle_fill_signed`.
/// Authorization + validation are performed by the callers before this runs.
fn execute_fill(env: &Env, fill: MatchedFill) -> Result<FillReceipt, CoreError> {
    settle_user_side(
        env,
        &fill.maker.owner,
        fill.maker.market_id,
        fill.maker.is_long,
        fill.maker.reduce_only,
        fill.fill_size,
        fill.fill_price,
    )?;
    engine_charge_trade_fee(
        env,
        &fill.maker.owner,
        fill.maker.market_id,
        fill.fill_size,
        fill.fill_price,
        true,
    )?;
    settle_user_side(
        env,
        &fill.taker.owner,
        fill.taker.market_id,
        fill.taker.is_long,
        fill.taker.reduce_only,
        fill.fill_size,
        fill.fill_price,
    )?;
    engine_charge_trade_fee(
        env,
        &fill.taker.owner,
        fill.taker.market_id,
        fill.fill_size,
        fill.fill_price,
        false,
    )?;

    let maker_filled = add_filled(
        env,
        &fill.maker.owner,
        fill.maker.nonce,
        fill.maker.expiry_ts,
        fill.fill_size,
    )?;
    let taker_filled = add_filled(
        env,
        &fill.taker.owner,
        fill.taker.nonce,
        fill.taker.expiry_ts,
        fill.fill_size,
    )?;

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

/// Verify a maker/taker ed25519 signature over the canonical order message.
///
/// Reconstructs the exact bytes the wallet signed and checks the signature
/// against the owner account's ed25519 public key. Must byte-match the
/// off-chain `orderSettlementMessage` in client/lib/market/signing-message.ts:
///
///   <domain>|place_order|<pubkey_hex>|<market_id>|<is_long 0/1>|<size>|
///   <limit_price>|<reduce_only 0/1>|<nonce>|<expiry_ts>
///
/// then wrapped per SEP-53: sha256("Stellar Signed Message:\n" || message),
/// which is the 32-byte value the wallet's ed25519 key signs.
fn verify_order_signature(env: &Env, order: &Order, sig: &BytesN<64>) -> Result<(), CoreError> {
    let domain: Bytes = env
        .storage()
        .instance()
        .get(&DataKey::Domain)
        .ok_or(CoreError::InvalidConfig)?;

    // The owner must be an ed25519 account address (G...); extract its 32-byte key.
    let pubkey: BytesN<32> = match order.owner.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(pk)) => pk,
        _ => return Err(CoreError::Unauthorized),
    };

    // Build the canonical message bytes.
    let mut msg = Bytes::new(env);
    msg.append(&domain);
    msg.extend_from_slice(b"|place_order|");
    append_hex(&mut msg, &pubkey.to_array());
    msg.push_back(b'|');
    append_decimal_u128(&mut msg, order.market_id as u128);
    msg.push_back(b'|');
    msg.push_back(if order.is_long { b'1' } else { b'0' });
    msg.push_back(b'|');
    append_decimal_i128(&mut msg, order.size);
    msg.push_back(b'|');
    append_decimal_i128(&mut msg, order.limit_price);
    msg.push_back(b'|');
    msg.push_back(if order.reduce_only { b'1' } else { b'0' });
    msg.push_back(b'|');
    append_decimal_u128(&mut msg, order.nonce as u128);
    msg.push_back(b'|');
    append_decimal_u128(&mut msg, order.expiry_ts as u128);

    // SEP-53 envelope, then ed25519 verify (panics on mismatch).
    let mut payload = Bytes::new(env);
    payload.extend_from_slice(b"Stellar Signed Message:\n");
    payload.append(&msg);
    let digest: Bytes = env.crypto().sha256(&payload).into();
    env.crypto().ed25519_verify(&pubkey, &digest, sig);
    Ok(())
}

/// Append the lowercase hex encoding of a 32-byte array (64 ASCII chars).
fn append_hex(buf: &mut Bytes, bytes: &[u8; 32]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    let mut i = 0;
    while i < 32 {
        out[i * 2] = HEX[(bytes[i] >> 4) as usize];
        out[i * 2 + 1] = HEX[(bytes[i] & 0x0f) as usize];
        i += 1;
    }
    buf.extend_from_slice(&out);
}

/// Append the base-10 ASCII representation of an unsigned integer.
fn append_decimal_u128(buf: &mut Bytes, v: u128) {
    if v == 0 {
        buf.push_back(b'0');
        return;
    }
    let mut tmp = [0u8; 40]; // u128 max is 39 digits
    let mut i = tmp.len();
    let mut n = v;
    while n > 0 {
        i -= 1;
        tmp[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    buf.extend_from_slice(&tmp[i..]);
}

/// Append the base-10 ASCII representation of a signed integer.
fn append_decimal_i128(buf: &mut Bytes, v: i128) {
    if v < 0 {
        buf.push_back(b'-');
        append_decimal_u128(buf, v.unsigned_abs());
    } else {
        append_decimal_u128(buf, v as u128);
    }
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
        .get::<DataKey, FilledEntry>(&DataKey::Filled(owner.clone(), nonce))
        .map(|entry| entry.amount)
        .unwrap_or(0)
}

fn add_filled(
    env: &Env,
    owner: &Address,
    nonce: u64,
    expiry_ts: u64,
    amount: i128,
) -> Result<i128, CoreError> {
    let next = checked_add(filled(env, owner, nonce), amount)?;
    let key = DataKey::Filled(owner.clone(), nonce);
    env.storage().persistent().set(
        &key,
        &FilledEntry {
            amount: next,
            expiry_ts,
        },
    );
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
    Ok(next)
}

fn is_cancelled(env: &Env, owner: &Address, nonce: u64) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Cancelled(owner.clone(), nonce))
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
    fn reclaim_prunes_only_expired_entries() {
        use soroban_sdk::testutils::Ledger;

        let s = setup();
        let expiry = s.env.ledger().timestamp() + 60;
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        s.gateway.settle_fill(&fill);
        s.gateway.cancel_order(&s.maker, &2, &expiry);
        assert_eq!(s.gateway.filled(&s.maker, &1), PRECISION);
        assert!(s.gateway.is_cancelled(&s.maker, &2));

        // Before expiry+grace: nothing may be reclaimed.
        let nonces = vec![&s.env, 1u64, 2u64];
        assert_eq!(s.gateway.reclaim_order_state(&s.maker, &nonces), 0);
        assert_eq!(s.gateway.filled(&s.maker, &1), PRECISION);
        assert!(s.gateway.is_cancelled(&s.maker, &2));

        // Jump past expiry + grace: both entries become reclaimable.
        s.env.ledger().with_mut(|l| {
            l.timestamp = expiry + RECLAIM_GRACE_SECS + 1;
        });
        assert_eq!(s.gateway.reclaim_order_state(&s.maker, &nonces), 2);
        assert_eq!(s.gateway.filled(&s.maker, &1), 0);
        assert!(!s.gateway.is_cancelled(&s.maker, &2));

        // Replay of the reclaimed order is still impossible: it is expired.
        assert!(s.gateway.try_settle_fill(&fill).is_err());
    }

    #[test]
    fn cancelled_order_cannot_fill() {
        let s = setup();
        s.gateway
            .cancel_order(&s.maker, &1, &(s.env.ledger().timestamp() + 60));
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
    fn guardian_can_pause_gateway_but_not_unpause() {
        let s = setup();
        let guardian = Address::generate(&s.env);
        let stranger = Address::generate(&s.env);
        s.gateway.set_guardian(&guardian);
        assert!(s.gateway.try_emergency_pause(&stranger).is_err());
        s.gateway.emergency_pause(&guardian);
        assert!(s.gateway.is_paused());
        // Unpause is admin-only; the mocked-admin call restores service.
        s.gateway.unpause();
        assert!(!s.gateway.is_paused());
    }

    #[test]
    fn paused_gateway_rejects_settle_fill() {
        let s = setup();
        s.gateway.emergency_pause(&s.admin);
        assert!(s.gateway.is_paused());
        let fill = MatchedFill {
            maker: order(s.maker.clone(), false, 1, &s.env),
            taker: order(s.taker.clone(), true, 7, &s.env),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        };
        assert!(s.gateway.try_settle_fill(&fill).is_err());
    }

    // --- C2: settle_fill_signed on-chain signature verification ---
    //
    // Golden vector captured from a real Freighter wallet signature (the wallet
    // signed the canonical order message via SEP-53). This pins the on-chain
    // message reconstruction byte-for-byte against the off-chain signer; if the
    // canonical layout, hex encoding, decimal formatting, SEP-53 prefix, or
    // domain ever drift, ed25519_verify panics and this test fails.

    const GOLDEN_PUBKEY: [u8; 32] = [
        0x37, 0x29, 0x3b, 0xc3, 0xe6, 0x17, 0xdb, 0x79, 0xa3, 0x13, 0xbb, 0x5f, 0xe8, 0x2d, 0xeb,
        0xcf, 0x71, 0x6e, 0x4e, 0x0c, 0x40, 0x56, 0x0e, 0x4c, 0xa3, 0x99, 0xf7, 0x4e, 0xf8, 0xd4,
        0xbd, 0x40,
    ];
    const GOLDEN_SIG: [u8; 64] = [
        0xa3, 0x1b, 0xd3, 0xdd, 0x51, 0xd5, 0x83, 0x38, 0x82, 0xc3, 0xa1, 0x50, 0x08, 0x0c, 0x7b,
        0xb3, 0x3f, 0xb5, 0xf3, 0x18, 0x0f, 0xba, 0x69, 0xcf, 0xa7, 0xd3, 0x07, 0x38, 0xd2, 0x79,
        0xb2, 0x02, 0x11, 0x12, 0x2c, 0x76, 0xbf, 0x5c, 0x6e, 0x4b, 0xf5, 0xb2, 0xde, 0xce, 0x0d,
        0xb7, 0x93, 0xf4, 0x23, 0x4f, 0x8e, 0x42, 0x31, 0xaf, 0x8e, 0xf6, 0x71, 0xc9, 0xa9, 0x31,
        0x4b, 0x2a, 0x71, 0x02,
    ];

    fn golden_order(env: &Env) -> Order {
        let owner = Address::from_payload(
            env,
            AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, &GOLDEN_PUBKEY)),
        );
        Order {
            owner,
            market_id: 1,
            is_long: false,
            size: 2_220_000,
            limit_price: 98_250_000_000_000_000,
            reduce_only: false,
            nonce: 1_780_730_744_551,
            expiry_ts: 1_780_734_344,
        }
    }

    #[test]
    fn settle_fill_signed_verifies_real_wallet_signature() {
        let env = Env::default();
        let gateway_id = env.register(PerpOrderGatewayContract, ());
        let order = golden_order(&env);
        let sig = BytesN::from_array(&env, &GOLDEN_SIG);
        let domain = Bytes::from_slice(&env, b"Test SDF Network ; September 2015");
        env.as_contract(&gateway_id, || {
            env.storage().instance().set(&DataKey::Domain, &domain);
            // Must not panic — a real wallet signature validates against the
            // contract's reconstructed canonical message.
            verify_order_signature(&env, &order, &sig).unwrap();
        });
    }

    #[test]
    #[should_panic]
    fn settle_fill_signed_rejects_tampered_order() {
        let env = Env::default();
        let gateway_id = env.register(PerpOrderGatewayContract, ());
        let mut order = golden_order(&env);
        order.size = 2_220_001; // tamper a single field
        let sig = BytesN::from_array(&env, &GOLDEN_SIG);
        let domain = Bytes::from_slice(&env, b"Test SDF Network ; September 2015");
        env.as_contract(&gateway_id, || {
            env.storage().instance().set(&DataKey::Domain, &domain);
            // ed25519_verify panics — the signature no longer matches the message.
            verify_order_signature(&env, &order, &sig).unwrap();
        });
    }

    #[test]
    #[should_panic]
    fn settle_fill_signed_rejects_wrong_domain() {
        let env = Env::default();
        let gateway_id = env.register(PerpOrderGatewayContract, ());
        let order = golden_order(&env);
        let sig = BytesN::from_array(&env, &GOLDEN_SIG);
        let domain = Bytes::from_slice(&env, b"Public Global Stellar Network ; September 2015");
        env.as_contract(&gateway_id, || {
            env.storage().instance().set(&DataKey::Domain, &domain);
            // Cross-network replay protection: wrong domain → verification fails.
            verify_order_signature(&env, &order, &sig).unwrap();
        });
    }
}
