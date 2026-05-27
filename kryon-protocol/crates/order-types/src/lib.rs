#![no_std]
#![forbid(unsafe_code)]

use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderKind {
    Limit,
    Market,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatcherOrder {
    pub order: Order,
    pub order_id: u128,
    pub kind: OrderKind,
    pub sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestingOrder {
    pub order: Order,
    pub order_id: u128,
    pub sequence: u64,
    pub remaining: i128,
}

impl MatcherOrder {
    pub fn limit(order: Order, order_id: u128, sequence: u64) -> Self {
        Self {
            order,
            order_id,
            kind: OrderKind::Limit,
            sequence,
        }
    }

    pub fn market(order: Order, order_id: u128, sequence: u64) -> Self {
        Self {
            order,
            order_id,
            kind: OrderKind::Market,
            sequence,
        }
    }
}
