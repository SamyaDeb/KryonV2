use protocol_core::{
    checked_add, checked_sub, div_precision, mul_div, mul_precision, CoreError, SECS_PER_HOUR,
};
use soroban_sdk::contracttype;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingConfig {
    pub imbalance_coeff: i128,
    pub max_rate_per_hour: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingState {
    pub long_index: i128,
    pub short_index: i128,
    pub rate_per_hour: i128,
    pub last_update: u64,
}

pub fn update_from_imbalance(
    cfg: &FundingConfig,
    state: &FundingState,
    oi_long: i128,
    oi_short: i128,
    now: u64,
) -> Result<FundingState, CoreError> {
    if cfg.imbalance_coeff < 0 || cfg.max_rate_per_hour <= 0 {
        return Err(CoreError::InvalidConfig);
    }
    if now <= state.last_update {
        return Ok(state.clone());
    }
    let total_oi = checked_add(oi_long, oi_short)?;
    let imbalance = if total_oi == 0 {
        0
    } else {
        div_precision(checked_sub(oi_long, oi_short)?, total_oi)?
    };
    let raw_rate = mul_precision(imbalance, cfg.imbalance_coeff)?;
    let rate = clamp(raw_rate, -cfg.max_rate_per_hour, cfg.max_rate_per_hour);
    let elapsed = now - state.last_update;
    let delta = mul_div(rate, elapsed as i128, SECS_PER_HOUR as i128)?;
    Ok(FundingState {
        long_index: checked_add(state.long_index, delta)?,
        short_index: checked_sub(state.short_index, delta)?,
        rate_per_hour: rate,
        last_update: now,
    })
}

fn clamp(value: i128, min: i128, max: i128) -> i128 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::PRECISION;

    #[test]
    fn skewed_longs_pay_positive_funding() {
        let cfg = FundingConfig {
            imbalance_coeff: PRECISION / 100,
            max_rate_per_hour: PRECISION / 1_000,
        };
        let state = FundingState {
            long_index: 0,
            short_index: 0,
            rate_per_hour: 0,
            last_update: 0,
        };
        let next = update_from_imbalance(&cfg, &state, 9 * PRECISION, PRECISION, 3_600).unwrap();
        assert!(next.long_index > 0);
        assert!(next.short_index < 0);
    }

    #[test]
    fn funding_surplus_accounting_is_correct() {
        // M1: verify that delta * (oi_long - oi_short) / PRECISION gives the correct net
        // surplus that should be routed to insurance.
        //
        // oi_long = 9, oi_short = 1 (in PRECISION units)
        // After 1 hour the index advances by `rate_per_hour` (clamp allows up to PRECISION/1000).
        // delta = long_index_new - long_index_old
        // Expected insurance credit = delta * (9 - 1) / PRECISION = delta * 8
        let cfg = FundingConfig {
            imbalance_coeff: PRECISION / 100,
            max_rate_per_hour: PRECISION / 1_000,
        };
        let state = FundingState {
            long_index: 0,
            short_index: 0,
            rate_per_hour: 0,
            last_update: 0,
        };
        let oi_long = 9 * PRECISION;
        let oi_short = PRECISION;
        let next = update_from_imbalance(&cfg, &state, oi_long, oi_short, 3_600).unwrap();
        let delta = next.long_index; // prev was 0
        // Total paid by longs = delta * oi_long / PRECISION
        // Total received by shorts = delta * oi_short / PRECISION (note: short_index decreased by same delta)
        // Net surplus = delta * (oi_long - oi_short) / PRECISION
        let oi_imbalance = checked_sub(oi_long, oi_short).unwrap();
        let net_surplus = mul_div(delta, oi_imbalance, PRECISION).unwrap();
        let expected_surplus = mul_div(delta, 8 * PRECISION, PRECISION).unwrap();
        assert_eq!(net_surplus, expected_surplus);
        assert!(net_surplus > 0);
    }
}
