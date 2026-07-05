use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CoreError {
    MathOverflow = 1,
    DivisionByZero = 2,
    InvalidAmount = 3,
    InvalidPrice = 4,
    InvalidConfig = 5,
    StaleOracle = 6,
    OracleConfidenceTooWide = 7,
    AccountInsolvent = 8,
    InsufficientCollateral = 9,
    NotLiquidatable = 10,
    Unauthorized = 11,
    AlreadyInitialized = 12,
    AssetDisabled = 13,
    PositionNotFound = 14,
    DirectionMismatch = 15,
    PriceOutsideBand = 16,
    OpenInterestExceeded = 17,
    LiquidationWouldNotImproveHealth = 18,
    InsuranceFundInsufficient = 19,
    OrderExpired = 20,
    OrderCancelled = 21,
    OrderOverfilled = 22,
    SelfTrade = 23,
    OracleQuorumNotMet = 24,
    OracleDeviationTooWide = 25,
    DuplicateOracleSource = 26,
    TooManyPositions = 27,
    DepositCapExceeded = 28,
}
