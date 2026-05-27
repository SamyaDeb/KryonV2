#![forbid(unsafe_code)]

use order_types::{MatchedFill, Order};
use protocol_core::{checked_add, checked_sub, CoreError, OracleSnapshot, Position};
use soroban_sdk::Address;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolEvent {
    OrderAccepted(Order),
    FillSettled(MatchedFill),
    OrderCancelled {
        owner: Address,
        nonce: u64,
    },
    PositionSynced {
        owner: Address,
        positions: Vec<Position>,
    },
    FundingUpdated {
        market_id: u32,
        long_index: i128,
        short_index: i128,
        ledger: u32,
    },
    OracleUpdated {
        snapshot: OracleSnapshot,
        ledger: u32,
    },
    InsuranceBadDebt {
        asset: Address,
        amount: i128,
    },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MarketView {
    pub market_id: u32,
    pub last_price: i128,
    pub volume: i128,
    pub open_interest_long: i128,
    pub open_interest_short: i128,
    pub funding_long_index: i128,
    pub funding_short_index: i128,
    pub last_oracle_price: i128,
    pub last_oracle_ledger: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountView {
    pub owner: Address,
    pub positions: Vec<Position>,
    pub cancelled_nonces: BTreeSet<u64>,
    pub filled_by_nonce: BTreeMap<u64, i128>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ApiState {
    markets: BTreeMap<u32, MarketView>,
    accounts: BTreeMap<String, AccountView>,
    bad_debt_by_asset: BTreeMap<String, i128>,
    processed_events: u64,
}

impl ApiState {
    pub fn apply(&mut self, event: ProtocolEvent) -> Result<(), CoreError> {
        match event {
            ProtocolEvent::OrderAccepted(order) => {
                let owner = order.owner.clone();
                let account = self.account_mut(owner.clone());
                account.owner = owner;
            }
            ProtocolEvent::FillSettled(fill) => self.apply_fill(fill)?,
            ProtocolEvent::OrderCancelled { owner, nonce } => {
                self.account_mut(owner).cancelled_nonces.insert(nonce);
            }
            ProtocolEvent::PositionSynced { owner, positions } => {
                self.account_mut(owner.clone()).owner = owner.clone();
                self.account_mut(owner).positions = positions;
                self.recompute_open_interest()?;
            }
            ProtocolEvent::FundingUpdated {
                market_id,
                long_index,
                short_index,
                ledger: _,
            } => {
                let market = self.market_mut(market_id);
                market.funding_long_index = long_index;
                market.funding_short_index = short_index;
            }
            ProtocolEvent::OracleUpdated { snapshot, ledger } => {
                let market_id = stable_market_id(&snapshot.asset.to_string());
                let market = self.market_mut(market_id);
                market.last_oracle_price = snapshot.price;
                market.last_oracle_ledger = ledger;
            }
            ProtocolEvent::InsuranceBadDebt { asset, amount } => {
                let current = self
                    .bad_debt_by_asset
                    .get(&address_key(&asset))
                    .copied()
                    .unwrap_or(0);
                self.bad_debt_by_asset
                    .insert(address_key(&asset), checked_add(current, amount)?);
            }
        }
        self.processed_events = self
            .processed_events
            .checked_add(1)
            .ok_or(CoreError::MathOverflow)?;
        Ok(())
    }

    pub fn apply_many<I>(&mut self, events: I) -> Result<(), CoreError>
    where
        I: IntoIterator<Item = ProtocolEvent>,
    {
        for event in events {
            self.apply(event)?;
        }
        Ok(())
    }

    pub fn market(&self, market_id: u32) -> Option<&MarketView> {
        self.markets.get(&market_id)
    }

    pub fn markets(&self) -> impl Iterator<Item = &MarketView> {
        self.markets.values()
    }

    pub fn account(&self, owner: &Address) -> Option<&AccountView> {
        self.accounts.get(&address_key(owner))
    }

    pub fn account_by_key(&self, owner_key: &str) -> Option<&AccountView> {
        self.accounts.get(owner_key)
    }

    pub fn accounts(&self) -> impl Iterator<Item = &AccountView> {
        self.accounts.values()
    }

    pub fn bad_debt(&self, asset: &Address) -> i128 {
        self.bad_debt_by_asset
            .get(&address_key(asset))
            .copied()
            .unwrap_or(0)
    }

    pub fn processed_events(&self) -> u64 {
        self.processed_events
    }

    fn apply_fill(&mut self, fill: MatchedFill) -> Result<(), CoreError> {
        if fill.fill_size <= 0 || fill.fill_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let market = self.market_mut(fill.maker.market_id);
        market.last_price = fill.fill_price;
        market.volume = checked_add(market.volume, fill.fill_size)?;
        self.add_filled(fill.maker.owner, fill.maker.nonce, fill.fill_size)?;
        self.add_filled(fill.taker.owner, fill.taker.nonce, fill.fill_size)?;
        Ok(())
    }

    fn add_filled(&mut self, owner: Address, nonce: u64, amount: i128) -> Result<(), CoreError> {
        let account = self.account_mut(owner.clone());
        account.owner = owner;
        let current = account.filled_by_nonce.get(&nonce).copied().unwrap_or(0);
        account
            .filled_by_nonce
            .insert(nonce, checked_add(current, amount)?);
        Ok(())
    }

    fn recompute_open_interest(&mut self) -> Result<(), CoreError> {
        for market in self.markets.values_mut() {
            market.open_interest_long = 0;
            market.open_interest_short = 0;
        }

        let positions: Vec<Position> = self
            .accounts
            .values()
            .flat_map(|account| account.positions.iter().cloned())
            .collect();
        for position in positions {
            let market = self.market_mut(position.market_id);
            if position.is_long {
                market.open_interest_long = checked_add(market.open_interest_long, position.size)?;
            } else {
                market.open_interest_short =
                    checked_add(market.open_interest_short, position.size)?;
            }
        }
        Ok(())
    }

    fn market_mut(&mut self, market_id: u32) -> &mut MarketView {
        self.markets.entry(market_id).or_insert_with(|| MarketView {
            market_id,
            ..MarketView::default()
        })
    }

    fn account_mut(&mut self, owner: Address) -> &mut AccountView {
        self.accounts
            .entry(address_key(&owner))
            .or_insert_with(|| AccountView {
                owner,
                positions: Vec::new(),
                cancelled_nonces: BTreeSet::new(),
                filled_by_nonce: BTreeMap::new(),
            })
    }
}

fn address_key(address: &Address) -> String {
    format!("{address:?}")
}

fn stable_market_id(symbol: &str) -> u32 {
    let mut id = 0_u32;
    for byte in symbol.bytes() {
        id = id.wrapping_mul(31).wrapping_add(byte as u32);
    }
    id.max(1)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketResponse {
    pub market_id: u32,
    pub last_price: i128,
    pub volume: i128,
    pub long_open_interest: i128,
    pub short_open_interest: i128,
}

impl From<&MarketView> for MarketResponse {
    fn from(value: &MarketView) -> Self {
        Self {
            market_id: value.market_id,
            last_price: value.last_price,
            volume: value.volume,
            long_open_interest: value.open_interest_long,
            short_open_interest: value.open_interest_short,
        }
    }
}

pub fn available_after_cancel(order: &Order, account: &AccountView) -> Result<i128, CoreError> {
    if account.cancelled_nonces.contains(&order.nonce) {
        return Ok(0);
    }
    let filled = account
        .filled_by_nonce
        .get(&order.nonce)
        .copied()
        .unwrap_or(0);
    checked_sub(order.size, filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{MarginMode, PRECISION};
    use soroban_sdk::{testutils::Address as _, Env};

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

    #[test]
    fn reconstructs_fill_and_nonce_state() {
        let env = Env::default();
        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let mut state = ApiState::default();
        state
            .apply(ProtocolEvent::FillSettled(MatchedFill {
                maker: order(maker.clone(), false, 1),
                taker: order(taker.clone(), true, 7),
                fill_size: PRECISION / 2,
                fill_price: 100 * PRECISION,
            }))
            .unwrap();

        let market = state.market(1).unwrap();
        assert_eq!(market.volume, PRECISION / 2);
        assert_eq!(
            state.account(&maker).unwrap().filled_by_nonce.get(&1),
            Some(&(PRECISION / 2))
        );
    }

    #[test]
    fn recomputes_open_interest_from_synced_positions() {
        let env = Env::default();
        let user = Address::generate(&env);
        let mut state = ApiState::default();
        state
            .apply(ProtocolEvent::PositionSynced {
                owner: user.clone(),
                positions: vec![Position {
                    position_id: 1,
                    owner: user,
                    market_id: 1,
                    size: 3 * PRECISION,
                    entry_price: 100 * PRECISION,
                    margin: 0,
                    is_long: true,
                    last_funding_index: 0,
                    mode: MarginMode::Cross,
                }],
            })
            .unwrap();

        assert_eq!(state.market(1).unwrap().open_interest_long, 3 * PRECISION);
    }
}
