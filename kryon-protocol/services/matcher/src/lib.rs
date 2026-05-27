#![forbid(unsafe_code)]

use order_types::{MatchedFill, MatcherOrder, Order, OrderKind, RestingOrder};
use protocol_core::CoreError;
use std::collections::VecDeque;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchOutcome {
    pub accepted_order_id: u128,
    pub fills: Vec<MatchedFill>,
    pub residual_resting: Option<RestingOrder>,
}

#[derive(Clone, Debug, Default)]
pub struct OrderBook {
    market_id: u32,
    bids: Vec<RestingOrder>,
    asks: Vec<RestingOrder>,
    next_sequence: u64,
    next_order_id: u128,
}

impl OrderBook {
    pub fn new(market_id: u32) -> Self {
        Self {
            market_id,
            bids: Vec::new(),
            asks: Vec::new(),
            next_sequence: 1,
            next_order_id: 1,
        }
    }

    pub fn submit_limit(&mut self, order: Order, now_ts: u64) -> Result<MatchOutcome, CoreError> {
        let sequence = self.take_sequence()?;
        let order_id = self.take_order_id()?;
        self.match_order(MatcherOrder::limit(order, order_id, sequence), now_ts)
    }

    pub fn submit_market(&mut self, order: Order, now_ts: u64) -> Result<MatchOutcome, CoreError> {
        let sequence = self.take_sequence()?;
        let order_id = self.take_order_id()?;
        self.match_order(MatcherOrder::market(order, order_id, sequence), now_ts)
    }

    pub fn cancel(&mut self, order_id: u128) -> bool {
        remove_by_id(&mut self.bids, order_id) || remove_by_id(&mut self.asks, order_id)
    }

    pub fn replace(
        &mut self,
        order_id: u128,
        mut replacement: Order,
        now_ts: u64,
    ) -> Result<MatchOutcome, CoreError> {
        if let Some(old) = remove_and_return(&mut self.bids, order_id)
            .or_else(|| remove_and_return(&mut self.asks, order_id))
        {
            replacement.nonce = old.order.nonce;
            return self.submit_limit(replacement, now_ts);
        }
        Err(CoreError::PositionNotFound)
    }

    pub fn bids(&self) -> &[RestingOrder] {
        &self.bids
    }

    pub fn asks(&self) -> &[RestingOrder] {
        &self.asks
    }

    fn match_order(
        &mut self,
        incoming: MatcherOrder,
        now_ts: u64,
    ) -> Result<MatchOutcome, CoreError> {
        validate_incoming(&incoming.order, self.market_id, now_ts)?;
        let mut remaining = incoming.order.size;
        let mut fills = Vec::new();
        let opposite = if incoming.order.is_long {
            &mut self.asks
        } else {
            &mut self.bids
        };
        prune_expired(opposite, now_ts);

        let mut queue = VecDeque::from(core::mem::take(opposite));
        let mut kept = Vec::new();
        while let Some(mut resting) = queue.pop_front() {
            if remaining == 0 {
                kept.push(resting);
                continue;
            }
            if resting.order.owner == incoming.order.owner {
                kept.push(resting);
                continue;
            }
            if !crosses(&incoming.order, &resting.order, incoming.kind) {
                kept.push(resting);
                continue;
            }
            let fill_size = core::cmp::min(remaining, resting.remaining);
            fills.push(MatchedFill {
                maker: resting.order.clone(),
                taker: incoming.order.clone(),
                fill_size,
                fill_price: resting.order.limit_price,
            });
            remaining -= fill_size;
            resting.remaining -= fill_size;
            if resting.remaining > 0 {
                kept.push(resting);
            }
        }
        *opposite = kept;

        let residual_resting = if remaining > 0 && incoming.kind == OrderKind::Limit {
            let resting = RestingOrder {
                order: incoming.order.clone(),
                order_id: incoming.order_id,
                sequence: incoming.sequence,
                remaining,
            };
            insert_resting(
                if incoming.order.is_long {
                    &mut self.bids
                } else {
                    &mut self.asks
                },
                resting.clone(),
                incoming.order.is_long,
            );
            Some(resting)
        } else {
            None
        };

        Ok(MatchOutcome {
            accepted_order_id: incoming.order_id,
            fills,
            residual_resting,
        })
    }

    fn take_sequence(&mut self) -> Result<u64, CoreError> {
        let current = self.next_sequence;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(CoreError::MathOverflow)?;
        Ok(current)
    }

    fn take_order_id(&mut self) -> Result<u128, CoreError> {
        let current = self.next_order_id;
        self.next_order_id = self
            .next_order_id
            .checked_add(1)
            .ok_or(CoreError::MathOverflow)?;
        Ok(current)
    }
}

fn validate_incoming(order: &Order, market_id: u32, now_ts: u64) -> Result<(), CoreError> {
    if order.market_id != market_id || order.market_id == 0 {
        return Err(CoreError::InvalidConfig);
    }
    if order.size <= 0 || order.limit_price <= 0 {
        return Err(CoreError::InvalidAmount);
    }
    if now_ts > order.expiry_ts {
        return Err(CoreError::OrderExpired);
    }
    Ok(())
}

fn crosses(incoming: &Order, resting: &Order, kind: OrderKind) -> bool {
    if kind == OrderKind::Market {
        return true;
    }
    if incoming.is_long {
        incoming.limit_price >= resting.limit_price
    } else {
        incoming.limit_price <= resting.limit_price
    }
}

fn insert_resting(book: &mut Vec<RestingOrder>, order: RestingOrder, is_bid: bool) {
    let index = book
        .iter()
        .position(|existing| {
            if is_bid {
                order.order.limit_price > existing.order.limit_price
                    || (order.order.limit_price == existing.order.limit_price
                        && order.sequence < existing.sequence)
            } else {
                order.order.limit_price < existing.order.limit_price
                    || (order.order.limit_price == existing.order.limit_price
                        && order.sequence < existing.sequence)
            }
        })
        .unwrap_or(book.len());
    book.insert(index, order);
}

fn prune_expired(book: &mut Vec<RestingOrder>, now_ts: u64) {
    book.retain(|order| now_ts <= order.order.expiry_ts);
}

fn remove_by_id(book: &mut Vec<RestingOrder>, order_id: u128) -> bool {
    if let Some(index) = book.iter().position(|order| order.order_id == order_id) {
        book.remove(index);
        return true;
    }
    false
}

fn remove_and_return(book: &mut Vec<RestingOrder>, order_id: u128) -> Option<RestingOrder> {
    book.iter()
        .position(|order| order.order_id == order_id)
        .map(|index| book.remove(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    const NOW: u64 = 1_000;
    const P: i128 = 1_000_000_000_000_000_000;

    fn owner(env: &Env) -> Address {
        Address::generate(env)
    }

    fn order(
        _env: &Env,
        owner: Address,
        is_long: bool,
        price: i128,
        size: i128,
        nonce: u64,
    ) -> Order {
        Order {
            owner,
            market_id: 1,
            is_long,
            size,
            limit_price: price,
            reduce_only: false,
            nonce,
            expiry_ts: NOW + 60,
        }
    }

    #[test]
    fn price_time_priority_prefers_best_price_then_oldest() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller_a = owner(&env);
        let seller_b = owner(&env);
        let seller_c = owner(&env);
        let buyer = owner(&env);

        book.submit_limit(order(&env, seller_a.clone(), false, 101 * P, P, 1), NOW)
            .unwrap();
        book.submit_limit(order(&env, seller_b.clone(), false, 100 * P, P, 2), NOW)
            .unwrap();
        book.submit_limit(order(&env, seller_c.clone(), false, 100 * P, P, 3), NOW)
            .unwrap();

        let out = book
            .submit_limit(order(&env, buyer, true, 101 * P, 2 * P, 4), NOW)
            .unwrap();
        assert_eq!(out.fills.len(), 2);
        assert_eq!(out.fills[0].maker.owner, seller_b);
        assert_eq!(out.fills[1].maker.owner, seller_c);
        assert_eq!(book.asks()[0].order.owner, seller_a);
    }

    #[test]
    fn partial_fill_leaves_resting_residual() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller = owner(&env);
        let buyer = owner(&env);

        book.submit_limit(order(&env, seller.clone(), false, 100 * P, 3 * P, 1), NOW)
            .unwrap();
        let out = book
            .submit_limit(order(&env, buyer, true, 100 * P, P, 2), NOW)
            .unwrap();

        assert_eq!(out.fills[0].fill_size, P);
        assert_eq!(book.asks()[0].order.owner, seller);
        assert_eq!(book.asks()[0].remaining, 2 * P);
    }

    #[test]
    fn cancel_removes_liquidity() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller = owner(&env);
        let order_id = book
            .submit_limit(order(&env, seller, false, 100 * P, P, 1), NOW)
            .unwrap()
            .accepted_order_id;
        assert!(book.cancel(order_id));
        assert!(book.asks().is_empty());
    }

    #[test]
    fn replace_loses_queue_priority() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller_a = owner(&env);
        let seller_b = owner(&env);
        let buyer = owner(&env);

        let replaced_id = book
            .submit_limit(order(&env, seller_a.clone(), false, 100 * P, P, 1), NOW)
            .unwrap()
            .accepted_order_id;
        book.submit_limit(order(&env, seller_b.clone(), false, 100 * P, P, 2), NOW)
            .unwrap();
        book.replace(
            replaced_id,
            order(&env, seller_a, false, 100 * P, P, 1),
            NOW,
        )
        .unwrap();

        let out = book
            .submit_limit(order(&env, buyer, true, 100 * P, P, 3), NOW)
            .unwrap();
        assert_eq!(out.fills[0].maker.owner, seller_b);
    }

    #[test]
    fn market_order_walks_book() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller_a = owner(&env);
        let seller_b = owner(&env);
        let buyer = owner(&env);

        book.submit_limit(order(&env, seller_a, false, 100 * P, P, 1), NOW)
            .unwrap();
        book.submit_limit(order(&env, seller_b, false, 101 * P, P, 2), NOW)
            .unwrap();

        let mut market = order(&env, buyer, true, i128::MAX, 2 * P, 3);
        market.limit_price = i128::MAX;
        let out = book.submit_market(market, NOW).unwrap();
        assert_eq!(out.fills.len(), 2);
        assert_eq!(out.fills[0].fill_price, 100 * P);
        assert_eq!(out.fills[1].fill_price, 101 * P);
        assert!(book.asks().is_empty());
    }

    #[test]
    fn expired_orders_do_not_fill() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller = owner(&env);
        let buyer = owner(&env);
        let mut stale = order(&env, seller, false, 100 * P, P, 1);
        stale.expiry_ts = NOW;
        book.submit_limit(stale, NOW).unwrap();

        let out = book
            .submit_limit(order(&env, buyer, true, 100 * P, P, 2), NOW + 1)
            .unwrap();
        assert!(out.fills.is_empty());
        assert!(book.asks().is_empty());
        assert_eq!(book.bids()[0].remaining, P);
    }

    #[test]
    fn self_trade_is_skipped_without_fill() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let trader = owner(&env);
        book.submit_limit(order(&env, trader.clone(), false, 100 * P, P, 1), NOW)
            .unwrap();
        let out = book
            .submit_limit(order(&env, trader, true, 100 * P, P, 2), NOW)
            .unwrap();
        assert!(out.fills.is_empty());
        assert_eq!(book.asks().len(), 1);
        assert_eq!(book.bids().len(), 1);
    }

    #[test]
    fn generated_fill_matches_gateway_shape() {
        let env = Env::default();
        let mut book = OrderBook::new(1);
        let seller = owner(&env);
        let buyer = owner(&env);
        book.submit_limit(order(&env, seller.clone(), false, 100 * P, P, 1), NOW)
            .unwrap();
        let out = book
            .submit_limit(order(&env, buyer.clone(), true, 100 * P, P, 2), NOW)
            .unwrap();
        let fill = &out.fills[0];
        assert_eq!(fill.maker.owner, seller);
        assert_eq!(fill.taker.owner, buyer);
        assert_eq!(fill.fill_size, P);
        assert_eq!(fill.fill_price, 100 * P);
        assert!(!fill.maker.is_long);
        assert!(fill.taker.is_long);
    }
}
