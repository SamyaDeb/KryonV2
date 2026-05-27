#![forbid(unsafe_code)]

use protocol_core::{checked_div, checked_mul, CoreError, OracleSource, PRECISION};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderQuote {
    pub source: OracleSource,
    pub price: i128,
    pub exponent: i32,
    pub confidence: i128,
    pub confidence_exponent: i32,
    pub publish_time: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedQuote {
    pub source: OracleSource,
    pub price: i128,
    pub confidence: i128,
    pub publish_time: u64,
}

pub fn normalize_quote(quote: ProviderQuote) -> Result<NormalizedQuote, CoreError> {
    if quote.price <= 0 || quote.confidence < 0 || quote.source == OracleSource::Quorum {
        return Err(CoreError::InvalidPrice);
    }

    Ok(NormalizedQuote {
        source: quote.source,
        price: normalize_decimal(quote.price, quote.exponent)?,
        confidence: normalize_decimal(quote.confidence, quote.confidence_exponent)?,
        publish_time: quote.publish_time,
    })
}

pub fn normalize_quotes(quotes: &[ProviderQuote]) -> Result<Vec<NormalizedQuote>, CoreError> {
    quotes.iter().cloned().map(normalize_quote).collect()
}

fn normalize_decimal(value: i128, exponent: i32) -> Result<i128, CoreError> {
    if exponent >= 0 {
        let scale = pow10(exponent as u32)?;
        return checked_mul(checked_mul(value, scale)?, PRECISION);
    }

    let divisor = pow10(exponent.unsigned_abs())?;
    checked_div(checked_mul(value, PRECISION)?, divisor)
}

fn pow10(exponent: u32) -> Result<i128, CoreError> {
    let mut result = 1_i128;
    for _ in 0..exponent {
        result = checked_mul(result, 10)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_pyth_style_negative_exponent() {
        let quote = normalize_quote(ProviderQuote {
            source: OracleSource::Pyth,
            price: 5_000_000_000_000,
            exponent: -8,
            confidence: 10_000_000,
            confidence_exponent: -8,
            publish_time: 100,
        })
        .unwrap();

        assert_eq!(quote.price, 50_000 * PRECISION);
        assert_eq!(quote.confidence, PRECISION / 10);
        assert_eq!(quote.publish_time, 100);
    }

    #[test]
    fn normalizes_positive_exponent_without_float_rounding() {
        let quote = normalize_quote(ProviderQuote {
            source: OracleSource::Reflector,
            price: 123,
            exponent: 2,
            confidence: 1,
            confidence_exponent: 0,
            publish_time: 100,
        })
        .unwrap();

        assert_eq!(quote.price, 12_300 * PRECISION);
        assert_eq!(quote.confidence, PRECISION);
    }

    #[test]
    fn rejects_quorum_as_provider_source() {
        assert_eq!(
            normalize_quote(ProviderQuote {
                source: OracleSource::Quorum,
                price: 1,
                exponent: 0,
                confidence: 0,
                confidence_exponent: 0,
                publish_time: 1,
            }),
            Err(CoreError::InvalidPrice)
        );
    }
}
