#![forbid(unsafe_code)]

use indexer_api::{ApiState, MarketResponse, ProtocolEvent};
use monitoring::{evaluate_runtime, Alert, RuntimeMetrics};
use protocol_core::CoreError;
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DATABASE_URL_ENV: &str = "DATABASE_URL";
pub const STELLAR_RPC_URL_ENV: &str = "STELLAR_RPC_URL";
pub const SIGNER_PROVIDER_ENV: &str = "SIGNER_PROVIDER";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConfig {
    pub bind_addr: String,
    pub max_request_bytes: usize,
    pub rpc_cursor: u64,
    pub tx_retry_limit: u32,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            bind_addr: "127.0.0.1:8080".to_string(),
            max_request_bytes: 8 * 1024,
            rpc_cursor: 0,
            tx_retry_limit: 3,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistenceConfig {
    pub database_url_env: String,
    pub max_connections: u32,
    pub statement_timeout_ms: u64,
    pub advisory_lock_key: i64,
}

impl Default for PersistenceConfig {
    fn default() -> Self {
        Self {
            database_url_env: DATABASE_URL_ENV.to_string(),
            max_connections: 16,
            statement_timeout_ms: 5_000,
            advisory_lock_key: 91_777_001,
        }
    }
}

impl PersistenceConfig {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.database_url_env.is_empty()
            || self.max_connections == 0
            || self.statement_timeout_ms == 0
        {
            return Err(CoreError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedEvent {
    pub sequence: u64,
    pub event: ProtocolEvent,
}

pub trait EventStore {
    fn append_event(&mut self, event: ProtocolEvent) -> Result<u64, CoreError>;
    fn replay_state(&self) -> Result<ApiState, CoreError>;
    fn latest_sequence(&self) -> u64;
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryStore {
    events: Vec<PersistedEvent>,
    state: ApiState,
}

impl InMemoryStore {
    pub fn append(&mut self, event: ProtocolEvent) -> Result<u64, CoreError> {
        let sequence = self
            .events
            .last()
            .map(|event| event.sequence + 1)
            .unwrap_or(1);
        self.state.apply(event.clone())?;
        self.events.push(PersistedEvent { sequence, event });
        Ok(sequence)
    }

    pub fn replay(&self) -> Result<ApiState, CoreError> {
        let mut state = ApiState::default();
        for event in &self.events {
            state.apply(event.event.clone())?;
        }
        Ok(state)
    }

    pub fn state(&self) -> &ApiState {
        &self.state
    }

    pub fn event_count(&self) -> usize {
        self.events.len()
    }
}

impl EventStore for InMemoryStore {
    fn append_event(&mut self, event: ProtocolEvent) -> Result<u64, CoreError> {
        self.append(event)
    }

    fn replay_state(&self) -> Result<ApiState, CoreError> {
        self.replay()
    }

    fn latest_sequence(&self) -> u64 {
        self.events.last().map(|event| event.sequence).unwrap_or(0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RpcEnvelope {
    pub ledger: u32,
    pub tx_hash: String,
    pub event: ProtocolEvent,
}

pub trait RpcEventSource {
    fn poll_events(&mut self, cursor: u64, limit: usize) -> Result<Vec<RpcEnvelope>, CoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StellarRpcConfig {
    pub rpc_url_env: String,
    pub network_passphrase: String,
    pub request_timeout_ms: u64,
    pub max_page_size: usize,
}

impl StellarRpcConfig {
    pub fn testnet() -> Self {
        Self {
            rpc_url_env: STELLAR_RPC_URL_ENV.to_string(),
            network_passphrase: "Test SDF Network ; September 2015".to_string(),
            request_timeout_ms: 8_000,
            max_page_size: 100,
        }
    }

    pub fn mainnet() -> Self {
        Self {
            rpc_url_env: STELLAR_RPC_URL_ENV.to_string(),
            network_passphrase: "Public Global Stellar Network ; September 2015".to_string(),
            request_timeout_ms: 8_000,
            max_page_size: 100,
        }
    }

    pub fn validate(&self) -> Result<(), CoreError> {
        if self.rpc_url_env.is_empty()
            || self.network_passphrase.is_empty()
            || self.request_timeout_ms == 0
            || self.max_page_size == 0
        {
            return Err(CoreError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RpcCursor {
    pub last_ledger: u32,
    pub paging_token: String,
}

pub trait StellarRpcClient {
    fn latest_ledger(&self) -> Result<u32, CoreError>;
    fn events_after(&self, cursor: &RpcCursor, limit: usize)
        -> Result<Vec<RpcEnvelope>, CoreError>;
    fn submit_transaction(&self, signed_xdr: &str) -> Result<TxSubmission, CoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TxSubmissionStatus {
    Pending,
    Duplicate,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TxSubmission {
    pub hash: String,
    pub latest_ledger: u32,
    pub status: TxSubmissionStatus,
}

#[derive(Clone, Debug, Default)]
pub struct ReplayRpcSource {
    events: Vec<RpcEnvelope>,
}

impl ReplayRpcSource {
    pub fn new(events: Vec<RpcEnvelope>) -> Self {
        Self { events }
    }
}

impl RpcEventSource for ReplayRpcSource {
    fn poll_events(&mut self, cursor: u64, limit: usize) -> Result<Vec<RpcEnvelope>, CoreError> {
        Ok(self
            .events
            .iter()
            .skip(cursor as usize)
            .take(limit)
            .cloned()
            .collect())
    }
}

pub fn ingest_once<S: RpcEventSource>(
    source: &mut S,
    store: &mut InMemoryStore,
    cursor: &mut u64,
    limit: usize,
) -> Result<usize, CoreError> {
    if limit == 0 {
        return Err(CoreError::InvalidConfig);
    }
    let events = source.poll_events(*cursor, limit)?;
    let count = events.len();
    for envelope in events {
        store.append(envelope.event)?;
        *cursor = cursor.checked_add(1).ok_or(CoreError::MathOverflow)?;
    }
    Ok(count)
}

pub fn ingest_once_into<S, T>(
    source: &mut S,
    store: &mut T,
    cursor: &mut u64,
    limit: usize,
) -> Result<usize, CoreError>
where
    S: RpcEventSource,
    T: EventStore,
{
    if limit == 0 {
        return Err(CoreError::InvalidConfig);
    }
    let events = source.poll_events(*cursor, limit)?;
    let count = events.len();
    for envelope in events {
        store.append_event(envelope.event)?;
        *cursor = cursor.checked_add(1).ok_or(CoreError::MathOverflow)?;
    }
    Ok(count)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TxStatus {
    Queued,
    Submitted,
    Confirmed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TxJob {
    pub id: u64,
    pub kind: String,
    pub payload_hash: String,
    pub attempts: u32,
    pub status: TxStatus,
}

#[derive(Clone, Debug, Default)]
pub struct TxQueue {
    next_id: u64,
    pending: VecDeque<TxJob>,
    history: BTreeMap<u64, TxJob>,
}

impl TxQueue {
    pub fn enqueue(&mut self, kind: impl Into<String>, payload_hash: impl Into<String>) -> u64 {
        self.next_id += 1;
        let job = TxJob {
            id: self.next_id,
            kind: kind.into(),
            payload_hash: payload_hash.into(),
            attempts: 0,
            status: TxStatus::Queued,
        };
        self.history.insert(job.id, job.clone());
        self.pending.push_back(job);
        self.next_id
    }

    pub fn mark_next_attempt(&mut self, retry_limit: u32) -> Result<Option<TxJob>, CoreError> {
        let Some(mut job) = self.pending.pop_front() else {
            return Ok(None);
        };
        if job.attempts >= retry_limit {
            job.status = TxStatus::Failed;
            self.history.insert(job.id, job.clone());
            return Ok(Some(job));
        }
        job.attempts = job.attempts.checked_add(1).ok_or(CoreError::MathOverflow)?;
        job.status = TxStatus::Submitted;
        self.history.insert(job.id, job.clone());
        Ok(Some(job))
    }

    pub fn confirm(&mut self, id: u64) -> Result<(), CoreError> {
        let mut job = self
            .history
            .get(&id)
            .cloned()
            .ok_or(CoreError::InvalidConfig)?;
        job.status = TxStatus::Confirmed;
        self.history.insert(id, job);
        Ok(())
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignerProvider {
    Kms,
    Vault,
    Fireblocks,
    LocalDev,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignRequest {
    pub network_passphrase: String,
    pub unsigned_xdr: String,
    pub signer_account: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedTransaction {
    pub signed_xdr: String,
    pub payload_hash: String,
}

pub trait TransactionSigner {
    fn provider(&self) -> SignerProvider;
    fn sign_transaction(&self, request: &SignRequest) -> Result<SignedTransaction, CoreError>;
}

pub fn sign_and_submit<S, R>(
    signer: &S,
    rpc: &R,
    request: &SignRequest,
) -> Result<TxSubmission, CoreError>
where
    S: TransactionSigner,
    R: StellarRpcClient,
{
    if request.network_passphrase.is_empty()
        || request.unsigned_xdr.is_empty()
        || request.signer_account.is_empty()
    {
        return Err(CoreError::InvalidConfig);
    }
    let signed = signer.sign_transaction(request)?;
    if signed.signed_xdr.is_empty() || signed.payload_hash.is_empty() {
        return Err(CoreError::InvalidConfig);
    }
    rpc.submit_transaction(&signed.signed_xdr)
}

#[derive(Clone)]
pub struct HttpState {
    store: Rc<RefCell<InMemoryStore>>,
    metrics: Rc<RefCell<RuntimeMetrics>>,
}

impl HttpState {
    pub fn new(store: InMemoryStore, metrics: RuntimeMetrics) -> Self {
        Self {
            store: Rc::new(RefCell::new(store)),
            metrics: Rc::new(RefCell::new(metrics)),
        }
    }
}

pub fn serve_one(listener: &TcpListener, state: &HttpState) -> std::io::Result<()> {
    let (mut stream, _) = listener.accept()?;
    handle_stream(&mut stream, state)
}

pub fn handle_stream(stream: &mut TcpStream, state: &HttpState) -> std::io::Result<()> {
    let mut buffer = [0_u8; 8192];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let body = route(path, state);
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())
}

pub fn route(path: &str, state: &HttpState) -> String {
    match path {
        "/health" => format!(
            "{{\"status\":\"ok\",\"timestamp\":{}}}",
            unix_timestamp_secs()
        ),
        "/metrics" => {
            let metrics = state.metrics.borrow();
            let alert_count = evaluate_runtime(&metrics)
                .map(|alerts| alerts.len())
                .unwrap_or(1);
            format!(
                "{{\"latest_ledger\":{},\"settlement_failures\":{},\"liquidation_backlog\":{},\"bad_debt\":{},\"alerts\":{}}}",
                metrics.latest_ledger,
                metrics.settlement_failures,
                metrics.liquidation_backlog,
                metrics.bad_debt,
                alert_count
            )
        }
        "/markets" => {
            let store = state.store.borrow();
            let markets: Vec<String> = store
                .state()
                .markets()
                .map(|market| market_response_json(&MarketResponse::from(market)))
                .collect();
            format!("[{}]", markets.join(","))
        }
        _ if path.starts_with("/markets/") => {
            let market_id = path
                .trim_start_matches("/markets/")
                .parse::<u32>()
                .unwrap_or(0);
            let store = state.store.borrow();
            store
                .state()
                .market(market_id)
                .map(|market| market_response_json(&MarketResponse::from(market)))
                .unwrap_or_else(|| "{\"error\":\"market_not_found\"}".to_string())
        }
        _ => "{\"error\":\"not_found\"}".to_string(),
    }
}

fn market_response_json(market: &MarketResponse) -> String {
    format!(
        "{{\"market_id\":{},\"last_price\":{},\"volume\":{},\"long_open_interest\":{},\"short_open_interest\":{}}}",
        market.market_id,
        market.last_price,
        market.volume,
        market.long_open_interest,
        market.short_open_interest
    )
}

fn unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

pub fn alert_codes(alerts: &[Alert]) -> Vec<&'static str> {
    alerts.iter().map(|alert| alert.code).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use order_types::{MatchedFill, Order};
    use protocol_core::PRECISION;
    use soroban_sdk::{testutils::Address as _, Address, Env};

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
    fn ingests_rpc_events_and_replays_state() {
        let env = Env::default();
        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let event = ProtocolEvent::FillSettled(MatchedFill {
            maker: order(maker, false, 1),
            taker: order(taker, true, 7),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        });
        let mut source = ReplayRpcSource::new(vec![RpcEnvelope {
            ledger: 1,
            tx_hash: "tx".to_string(),
            event,
        }]);
        let mut store = InMemoryStore::default();
        let mut cursor = 0;

        assert_eq!(
            ingest_once(&mut source, &mut store, &mut cursor, 100).unwrap(),
            1
        );
        assert_eq!(store.replay().unwrap().market(1).unwrap().volume, PRECISION);
    }

    #[test]
    fn generic_event_store_ingestion_uses_durable_boundary() {
        let env = Env::default();
        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let event = ProtocolEvent::FillSettled(MatchedFill {
            maker: order(maker, false, 1),
            taker: order(taker, true, 7),
            fill_size: PRECISION,
            fill_price: 100 * PRECISION,
        });
        let mut source = ReplayRpcSource::new(vec![RpcEnvelope {
            ledger: 1,
            tx_hash: "tx".to_string(),
            event,
        }]);
        let mut store = InMemoryStore::default();
        let mut cursor = 0;

        assert_eq!(
            ingest_once_into(&mut source, &mut store, &mut cursor, 100).unwrap(),
            1
        );
        assert_eq!(store.latest_sequence(), 1);
        assert_eq!(
            store.replay_state().unwrap().market(1).unwrap().volume,
            PRECISION
        );
    }

    #[derive(Clone, Debug)]
    struct TestSigner;

    impl TransactionSigner for TestSigner {
        fn provider(&self) -> SignerProvider {
            SignerProvider::LocalDev
        }

        fn sign_transaction(&self, request: &SignRequest) -> Result<SignedTransaction, CoreError> {
            Ok(SignedTransaction {
                signed_xdr: format!("signed:{}", request.unsigned_xdr),
                payload_hash: "hash".to_string(),
            })
        }
    }

    #[derive(Clone, Debug)]
    struct TestRpc;

    impl StellarRpcClient for TestRpc {
        fn latest_ledger(&self) -> Result<u32, CoreError> {
            Ok(10)
        }

        fn events_after(
            &self,
            _cursor: &RpcCursor,
            _limit: usize,
        ) -> Result<Vec<RpcEnvelope>, CoreError> {
            Ok(Vec::new())
        }

        fn submit_transaction(&self, signed_xdr: &str) -> Result<TxSubmission, CoreError> {
            Ok(TxSubmission {
                hash: signed_xdr.to_string(),
                latest_ledger: 10,
                status: TxSubmissionStatus::Pending,
            })
        }
    }

    #[test]
    fn signer_boundary_rejects_empty_requests_and_submits_signed_xdr() {
        let signer = TestSigner;
        let rpc = TestRpc;
        let bad = SignRequest {
            network_passphrase: String::new(),
            unsigned_xdr: "xdr".to_string(),
            signer_account: "GABC".to_string(),
        };
        assert!(sign_and_submit(&signer, &rpc, &bad).is_err());

        let good = SignRequest {
            network_passphrase: StellarRpcConfig::testnet().network_passphrase,
            unsigned_xdr: "xdr".to_string(),
            signer_account: "GABC".to_string(),
        };
        let submitted = sign_and_submit(&signer, &rpc, &good).unwrap();
        assert_eq!(submitted.hash, "signed:xdr");
    }

    #[test]
    fn tx_queue_limits_retries_and_confirms() {
        let mut queue = TxQueue::default();
        let id = queue.enqueue("funding", "abc");
        let first = queue.mark_next_attempt(1).unwrap().unwrap();
        assert_eq!(first.status, TxStatus::Submitted);
        queue.confirm(id).unwrap();
        assert_eq!(queue.pending_len(), 0);
    }

    #[test]
    fn routes_market_json() {
        let env = Env::default();
        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let mut store = InMemoryStore::default();
        store
            .append(ProtocolEvent::FillSettled(MatchedFill {
                maker: order(maker, false, 1),
                taker: order(taker, true, 7),
                fill_size: PRECISION,
                fill_price: 100 * PRECISION,
            }))
            .unwrap();
        let state = HttpState::new(
            store,
            RuntimeMetrics {
                latest_ledger: 1,
                matcher_queue_depth: 0,
                settlement_failures: 0,
                liquidation_backlog: 0,
                bad_debt: 0,
            },
        );

        assert!(route("/markets/1", &state).contains("\"volume\":1000000000000000000"));
    }
}
