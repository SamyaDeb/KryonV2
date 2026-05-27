#![no_std]
#![deny(unsafe_code)]

use protocol_core::CoreError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Guardian,
    MinDelay,
    Paused,
    Proposal(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Queued,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceProposal {
    pub id: BytesN<32>,
    pub target: Address,
    pub action: Symbol,
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
    pub status: ProposalStatus,
}

#[contract]
pub struct PerpGovernanceContract;

#[contractimpl]
impl PerpGovernanceContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        min_delay_secs: u64,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        if min_delay_secs == 0 {
            return Err(CoreError::InvalidConfig);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage()
            .instance()
            .set(&DataKey::MinDelay, &min_delay_secs);
        env.storage().instance().set(&DataKey::Paused, &false);
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

    pub fn queue(
        env: Env,
        id: BytesN<32>,
        target: Address,
        action: Symbol,
        wasm_hash: BytesN<32>,
        eta: u64,
    ) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        if env
            .storage()
            .persistent()
            .has(&DataKey::Proposal(id.clone()))
        {
            return Err(CoreError::AlreadyInitialized);
        }
        let min_delay = min_delay(&env)?;
        let earliest = env
            .ledger()
            .timestamp()
            .checked_add(min_delay)
            .ok_or(CoreError::MathOverflow)?;
        if eta < earliest {
            return Err(CoreError::InvalidConfig);
        }
        let proposal = GovernanceProposal {
            id: id.clone(),
            target,
            action,
            wasm_hash,
            eta,
            status: ProposalStatus::Queued,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        Ok(proposal)
    }

    pub fn execute(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        let mut proposal = proposal(&env, &id)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(CoreError::InvalidConfig);
        }
        if env.ledger().timestamp() < proposal.eta {
            return Err(CoreError::Unauthorized);
        }
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        Ok(proposal)
    }

    pub fn cancel(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        let mut proposal = proposal(&env, &id)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(CoreError::InvalidConfig);
        }
        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        Ok(proposal)
    }

    pub fn emergency_pause(env: Env, paused: bool) -> Result<(), CoreError> {
        require_guardian(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    pub fn set_guardian(env: Env, guardian: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        Ok(())
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn proposal(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        proposal(&env, &id)
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

fn require_guardian(env: &Env) -> Result<Address, CoreError> {
    let guardian: Address = env
        .storage()
        .instance()
        .get(&DataKey::Guardian)
        .ok_or(CoreError::InvalidConfig)?;
    guardian.require_auth();
    Ok(guardian)
}

fn min_delay(env: &Env) -> Result<u64, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::MinDelay)
        .ok_or(CoreError::InvalidConfig)
}

fn proposal(env: &Env, id: &BytesN<32>) -> Result<GovernanceProposal, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id.clone()))
        .ok_or(CoreError::InvalidConfig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol,
    };

    fn setup() -> (Env, Address, Address, PerpGovernanceContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 100;
        });
        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let contract_id = env.register(PerpGovernanceContract, ());
        let governance = PerpGovernanceContractClient::new(&env, &contract_id);
        governance.initialize(&admin, &guardian, &60);
        (env, admin, guardian, governance)
    }

    #[test]
    fn rejects_short_timelock_eta() {
        let (env, _admin, _guardian, governance) = setup();
        let result = governance.try_queue(
            &id(&env, 1),
            &Address::generate(&env),
            &Symbol::new(&env, "upgrade"),
            &id(&env, 2),
            &159,
        );

        assert!(result.is_err());
    }

    #[test]
    fn queues_and_executes_after_delay() {
        let (env, _admin, _guardian, governance) = setup();
        let proposal_id = id(&env, 3);
        governance.queue(
            &proposal_id,
            &Address::generate(&env),
            &Symbol::new(&env, "upgrade"),
            &id(&env, 4),
            &160,
        );
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 160;
        });

        let executed = governance.execute(&proposal_id);
        assert_eq!(executed.status, ProposalStatus::Executed);
    }

    #[test]
    fn guardian_can_pause() {
        let (_env, _admin, _guardian, governance) = setup();
        governance.emergency_pause(&true);
        assert!(governance.paused());
    }

    fn id(env: &Env, value: u8) -> BytesN<32> {
        BytesN::from_array(env, &[value; 32])
    }
}
