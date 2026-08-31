#![no_std]

pub mod pool;

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, panic_with_error, symbol_short,
    Address, BytesN, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    InvalidAmount      = 1,
    AlreadyPaid        = 2,
    EmptyId            = 3,
    AlreadyInitialized = 4,
    NotInitialized     = 5,
    InvalidActor       = 6,
    IdTooLong          = 7,
    AmountTooLarge     = 8,
    VersionMismatch    = 9,
    TxHashTooLong      = 10,
    NotPaid            = 11,
    Unauthorized       = 12,
}

#[contracttype]
#[derive(Clone)]
pub struct PaymentRecordV1 {
    pub expense_id: String,
    pub payer:      Address,
    pub member:     Address,
    pub amount:     i128,
    pub tx_hash:    String,
    pub timestamp:  u64,
}

#[contracttype]
#[derive(Clone)]
pub struct PaymentRecord {
    pub expense_id: String,
    pub payer:      Address,
    pub member:     Address,
    pub amount:     i128,
    pub tx_hash:    String,
    pub timestamp:  u64,
    /// `true` only when a configured attestor co-signed this record, meaning
    /// something actually checked the Stellar transaction behind `tx_hash`.
    /// `false` means the record is self-attested by the member: the contract
    /// stores the string but verifies nothing about it.
    pub attested:   bool,
}

#[contracttype]
#[derive(Clone)]
pub struct PaymentEventV1 {
    pub version:     u32,
    pub expense_id:  String,
    pub payer:       Address,
    pub member:      Address,
    pub amount:      i128,
    pub tx_hash:     String,
    pub timestamp:   u64,
    pub attested:    bool,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolConfigEventV1 {
    pub version:      u32,
    pub pool_contract: Address,
    pub updated_by:   Address,
    pub timestamp:    u64,
}

#[contracttype]
pub enum DataKey {
    /// Tracks the set of expense IDs that have at least one recorded payment for a trip.
    /// This keeps the trip-level index bounded while payment history stays keyed by expense.
    TripExpenseIds(String),
    /// Payments for a specific trip and expense; prevents one huge ledger vector from
    /// accumulating across the entire trip.
    ExpensePayments(String, String),
    ExpensePaid(String, Address),
    Admin,
    PoolContract,
    Version,
    /// Optional off-chain verifier. When set, it must co-sign every
    /// `record_payment`; when unset, records are self-attested.
    Attestor,
}

const LEDGERS_PER_DAY:        u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT:    u32 = LEDGERS_PER_DAY * 365;
const CONTRACT_VERSION:       u32 = 2;
const MIN_MIGRATABLE_VERSION:  u32 = 1;
const MAX_ID_LEN:             u32 = 64;
const MAX_TX_HASH_LEN:        u32 = 128;
const MAX_AMOUNT_STROOPS:     i128 = 10_000_000_000_000_000;

#[contract]
pub struct SettleXContract;

#[contractimpl]
impl SettleXContract {

    pub fn init(env: Env, admin: Address, pool_contract: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, ContractError::AlreadyInitialized);
        }

        if admin == pool_contract {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PoolContract, &pool_contract);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish((symbol_short!("stx_ini"),), CONTRACT_VERSION);
    }

    /// Installs new WASM for this contract. If the replacement changes storage
    /// shape or bumps `CONTRACT_VERSION`, call `migrate` after upgrading.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = Self::require_admin_at_supported_version(&env);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.events().publish(
            (symbol_short!("upgrade"),),
            (CONTRACT_VERSION, admin, env.ledger().timestamp()),
        );
    }

    /// Bumps instance state from a supported older version to the current one.
    ///
    /// v1 payment vectors remain readable through `get_payments`, which maps
    /// them to v2 records with `attested: false`. v1 did not keep a global trip
    /// index, so this avoids an impossible full-ledger enumeration.
    pub fn migrate(env: Env) {
        let old_version = Self::read_version(&env);
        if old_version == CONTRACT_VERSION {
            return;
        }
        if old_version < MIN_MIGRATABLE_VERSION || old_version > CONTRACT_VERSION {
            panic_with_error!(&env, ContractError::VersionMismatch);
        }

        let admin = Self::require_admin_at_supported_version(&env);
        env.storage().instance().set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("migrate"),),
            (old_version, CONTRACT_VERSION, admin, env.ledger().timestamp()),
        );
    }

    pub fn set_pool_contract(env: Env, pool_contract: Address) {
        Self::require_current_version(&env);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));

        if pool_contract == admin {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::PoolContract, &pool_contract);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pool_cfg"),),
            PoolConfigEventV1 {
                version: CONTRACT_VERSION,
                pool_contract,
                updated_by: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    pub fn get_pool_contract(env: Env) -> Address {
        Self::require_current_version(&env);

        let pool = env.storage()
            .instance()
            .get(&DataKey::PoolContract)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        pool
    }

    /// Reads the admin, panicking if the contract is uninitialized or on a
    /// different version.
    fn require_admin(env: &Env) -> Address {
        Self::require_current_version(env);
        Self::require_admin_at_supported_version(env)
    }

    fn read_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized))
    }

    fn require_current_version(env: &Env) {
        if Self::read_version(env) != CONTRACT_VERSION {
            panic_with_error!(env, ContractError::VersionMismatch);
        }
    }

    fn require_admin_at_supported_version(env: &Env) -> Address {
        let version = Self::read_version(env);
        if version < MIN_MIGRATABLE_VERSION || version > CONTRACT_VERSION {
            panic_with_error!(env, ContractError::VersionMismatch);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized));
        admin.require_auth();
        admin
    }

    /// Configures the off-chain verifier that must co-sign `record_payment`.
    ///
    /// This is the hook for binding a record to something real: a verifier that
    /// checks the Horizon transaction (payer, destination, amount, memo) before
    /// co-signing. Until one is set, records are self-attested and prove only
    /// that the member wrote a string — see `attested` on `PaymentRecord`.
    pub fn set_attestor(env: Env, attestor: Address) {
        let admin = Self::require_admin(&env);

        if attestor == admin {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        env.storage().instance().set(&DataKey::Attestor, &attestor);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("attestor"),),
            PoolConfigEventV1 {
                version: CONTRACT_VERSION,
                pool_contract: attestor,
                updated_by: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Removes the attestor requirement, returning the contract to
    /// self-attested records.
    pub fn clear_attestor(env: Env) {
        let admin = Self::require_admin(&env);
        env.storage().instance().remove(&DataKey::Attestor);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("attest_c"),),
            (CONTRACT_VERSION, admin, env.ledger().timestamp()),
        );
    }

    /// The configured attestor, or `None` when records are self-attested.
    pub fn get_attestor(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Attestor)
    }

    /// Admin-gated escape hatch for the paid flag.
    ///
    /// Without this, a bogus or mistaken record for `(expense_id, member)` locks
    /// that pair forever: `record_payment` panics with `AlreadyPaid` and the
    /// legitimate record can never be written. Clearing the flag lets the real
    /// payment be recorded.
    ///
    /// It deliberately does NOT remove the original entry from the trip's
    /// payment history — the audit trail stays intact, and the fact that a flag
    /// was cleared is emitted as an event.
    pub fn clear_paid(env: Env, expense_id: String, member: Address) {
        let admin = Self::require_admin(&env);

        if expense_id.len() == 0 {
            panic_with_error!(&env, ContractError::EmptyId);
        }
        if expense_id.len() > MAX_ID_LEN {
            panic_with_error!(&env, ContractError::IdTooLong);
        }

        let paid_key = DataKey::ExpensePaid(expense_id.clone(), member.clone());
        if !env.storage().persistent().has(&paid_key) {
            panic_with_error!(&env, ContractError::NotPaid);
        }

        env.storage().persistent().remove(&paid_key);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pmt_clr"), expense_id),
            (CONTRACT_VERSION, member, admin, env.ledger().timestamp()),
        );
    }

    pub fn record_payment(
        env:        Env,
        trip_id:    String,
        expense_id: String,
        payer:      Address,
        member:     Address,
        amount:     i128,
        tx_hash:    String,
    ) {
        member.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, ContractError::InvalidAmount);
        }
        if amount > MAX_AMOUNT_STROOPS {
            panic_with_error!(&env, ContractError::AmountTooLarge);
        }
        if payer == member {
            panic_with_error!(&env, ContractError::InvalidActor);
        }
        if trip_id.len() == 0 || expense_id.len() == 0 || tx_hash.len() == 0 {
            panic_with_error!(&env, ContractError::EmptyId);
        }
        if trip_id.len() > MAX_ID_LEN || expense_id.len() > MAX_ID_LEN {
            panic_with_error!(&env, ContractError::IdTooLong);
        }
        if tx_hash.len() > MAX_TX_HASH_LEN {
            panic_with_error!(&env, ContractError::TxHashTooLong);
        }

        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));
        if version != CONTRACT_VERSION {
            panic_with_error!(&env, ContractError::VersionMismatch);
        }

        let paid_key = DataKey::ExpensePaid(expense_id.clone(), member.clone());
        if env.storage().persistent().has(&paid_key) {
            panic_with_error!(&env, ContractError::AlreadyPaid);
        }

        // When an attestor is configured it must co-sign, which is what lets a
        // record mean "the Stellar transaction behind this hash was checked".
        // With no attestor the record is self-attested: the contract stores
        // `payer`, `amount` and `tx_hash` exactly as given and verifies none of
        // them. `attested` carries that distinction to every consumer.
        let attestor: Option<Address> = env.storage().instance().get(&DataKey::Attestor);
        let attested = match attestor {
            Some(addr) => {
                addr.require_auth();
                true
            }
            None => false,
        };

        let record = PaymentRecord {
            expense_id: expense_id.clone(),
            payer: payer.clone(),
            member:    member.clone(),
            amount,
            tx_hash: tx_hash.clone(),
            timestamp: env.ledger().timestamp(),
            attested,
        };

        let expense_key = DataKey::ExpensePayments(trip_id.clone(), expense_id.clone());
        let mut payments: Vec<PaymentRecord> = env
            .storage()
            .persistent()
            .get(&expense_key)
            .unwrap_or_else(|| Vec::new(&env));
        payments.push_back(record);
        env.storage().persistent().set(&expense_key, &payments);
        env.storage()
            .persistent()
            .extend_ttl(&expense_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        let trip_expenses_key = DataKey::TripExpenseIds(trip_id.clone());
        let mut trip_expenses: Vec<String> = env
            .storage()
            .persistent()
            .get(&trip_expenses_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut already_indexed = false;
        for existing in trip_expenses.iter() {
            if existing == expense_id {
                already_indexed = true;
                break;
            }
        }
        if !already_indexed {
            trip_expenses.push_back(expense_id.clone());
            env.storage().persistent().set(&trip_expenses_key, &trip_expenses);
            env.storage()
                .persistent()
                .extend_ttl(&trip_expenses_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        }

        env.storage().persistent().set(&paid_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&paid_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pmt_rec"), trip_id),
            PaymentEventV1 {
                version: CONTRACT_VERSION,
                expense_id,
                payer,
                member,
                amount,
                tx_hash,
                timestamp: env.ledger().timestamp(),
                attested,
            },
        );
    }

    /// Reading a trip's history also renews it.
    ///
    /// Only `record_payment` used to bump these keys, so a trip that is read
    /// often but written rarely could have its entries archived once the bump
    /// window elapsed -- leaving the history unreadable until someone paid a
    /// restore fee. Extending on read keeps live data live, the same way
    /// `pool::balance_of` does.
    pub fn get_payments(env: Env, trip_id: String) -> Vec<PaymentRecord> {
        let trip_expenses_key = DataKey::TripExpenseIds(trip_id.clone());
        let trip_expenses: Vec<String> = env
            .storage()
            .persistent()
            .get(&trip_expenses_key)
            .unwrap_or_else(|| Vec::new(&env));

        // `extend_ttl` traps on a key that does not exist, so every bump here is
        // guarded by the presence check that precedes it. A trip with no
        // payments is an ordinary empty read, not an error.
        if env.storage().persistent().has(&trip_expenses_key) {
            env.storage().persistent().extend_ttl(
                &trip_expenses_key,
                STORAGE_BUMP_THRESHOLD,
                STORAGE_BUMP_AMOUNT,
            );
        }

        let mut payments = Vec::new(&env);
        for expense_id in trip_expenses.iter() {
            let key = DataKey::ExpensePayments(trip_id.clone(), expense_id.clone());
            let expense_payments: Vec<PaymentRecord> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or_else(|| Vec::new(&env));

            // The index and the per-expense entries expire independently, so
            // renew each one we actually touched rather than assuming the index
            // outliving them means they survived too.
            if env.storage().persistent().has(&key) {
                env.storage().persistent().extend_ttl(
                    &key,
                    STORAGE_BUMP_THRESHOLD,
                    STORAGE_BUMP_AMOUNT,
                );
            }

            for payment in expense_payments.iter() {
                payments.push_back(payment);
            }
        }

        payments
    }

    /// Checking a member's paid status also renews the record.
    ///
    /// Without this a settled share that is only ever read -- the common case
    /// once a trip winds down -- could be archived, and the UI would then show
    /// an already-settled share as unpaid.
    pub fn is_paid(env: Env, expense_id: String, member: Address) -> bool {
        let key = DataKey::ExpensePaid(expense_id, member);
        let paid = env.storage().persistent().has(&key);

        if paid {
            env.storage()
                .persistent()
                .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        }

        paid
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::pool::{SettlementPoolContract, SettlementPoolContractClient};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal, String,
    };

    macro_rules! setup {
        ($env:ident, $client:ident, $pool_client:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let settlement_contract_id = $env.register_contract(None, SettleXContract);
            let pool_contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettleXContractClient::new(&$env, &settlement_contract_id);
            let $pool_client = SettlementPoolContractClient::new(&$env, &pool_contract_id);

            let admin = Address::generate(&$env);
            let settlement_address = settlement_contract_id.clone();
            let pool_address = pool_contract_id.clone();

            $pool_client.init_pool(&admin, &settlement_address);
            $client.init(&admin, &pool_address);
        };
    }

    /// End-to-end proof that the pool's settlement-contract check does not break
    /// the legitimate path, verified WITHOUT `mock_all_auths()`.
    ///
    /// The member authorizes `record_payment`; the nested pool `withdraw` is
    /// authorized for the settlement contract by the host, because a contract
    /// making a sub-invocation authorizes itself from the invocation stack.
    // ── Escape hatch for the permanent paid-flag lock ────────────────────

    /// The griefing scenario: a bogus record for (expense_id, member) makes the
    /// legitimate one impossible forever. `clear_paid` has to break that.
    #[test]
    fn test_clear_paid_unblocks_a_griefed_expense() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-grief");
        let expense_id = String::from_str(&env, "exp-grief");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        let bogus_hash = String::from_str(&env, "bogus000000");
        let real_hash = String::from_str(&env, "real1234567");

        pool_client.deposit(&member, &10_000_000_i128);

        // Bogus entry lands first and locks the pair.
        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_i128, &bogus_hash);
        assert!(client.is_paid(&expense_id, &member));

        // Before the fix there was no way past this point.
        client.clear_paid(&expense_id, &member);
        assert!(!client.is_paid(&expense_id, &member));

        // The real payment can now be recorded.
        client.record_payment(
            &trip_id, &expense_id, &payer, &member, &4_000_000_i128, &real_hash,
        );
        assert!(client.is_paid(&expense_id, &member));

        // History is preserved rather than rewritten — both attempts remain
        // visible for audit.
        let payments = client.get_payments(&trip_id);
        assert_eq!(payments.len(), 2);
        assert_eq!(payments.get(1).unwrap().tx_hash, real_hash);
    }

    #[test]
    #[should_panic]
    fn test_clear_paid_rejects_unknown_entry() {
        setup!(env, client, _pool_client);
        let member = Address::generate(&env);
        client.clear_paid(&String::from_str(&env, "never-recorded"), &member);
    }

    /// `clear_paid` is admin-gated: anyone else clearing flags would let a
    /// member wipe their own record and replay it.
    #[test]
    #[should_panic]
    fn test_clear_paid_requires_admin_auth() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let member = Address::generate(&env);

        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);
        pool_client.deposit(&member, &10_000_000_i128);

        let trip_id = String::from_str(&env, "trip-auth");
        let expense_id = String::from_str(&env, "exp-auth");
        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &1_000_000_i128,
            &String::from_str(&env, "hash1234567"),
        );

        // Only the member authorizes — not the admin.
        env.set_auths(&[]);
        env.mock_auths(&[MockAuth {
            address: &member,
            invoke: &MockAuthInvoke {
                contract: &settlement_contract_id,
                fn_name: "clear_paid",
                args: (expense_id.clone(), member.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.clear_paid(&expense_id, &member);
    }

    // ── Attestor: the hook that makes a record mean something ─────────────

    /// With no attestor the record is self-attested, and says so.
    #[test]
    fn test_records_are_self_attested_by_default() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-selfatt");
        let expense_id = String::from_str(&env, "exp-selfatt");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);

        pool_client.deposit(&member, &10_000_000_i128);
        assert!(client.get_attestor().is_none());

        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &1_000_000_i128,
            &String::from_str(&env, "unverified1"),
        );

        let rec = client.get_payments(&trip_id).get(0).unwrap();
        assert!(
            !rec.attested,
            "a record nothing verified must not claim to be attested",
        );
    }

    /// Once an attestor is configured it must co-sign, and the record is marked
    /// attested. Uses real auth so the requirement is actually exercised.
    #[test]
    fn test_attested_record_requires_and_records_attestor() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);
        let payer = Address::generate(&env);
        let member = Address::generate(&env);

        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);
        client.set_attestor(&attestor);
        pool_client.deposit(&member, &10_000_000_i128);
        assert_eq!(client.get_attestor(), Some(attestor.clone()));

        let trip_id = String::from_str(&env, "trip-att");
        let expense_id = String::from_str(&env, "exp-att");
        let tx_hash = String::from_str(&env, "verified123");
        let amount = 4_000_000_i128;
        let args: soroban_sdk::Vec<soroban_sdk::Val> = (
            trip_id.clone(), expense_id.clone(), payer.clone(),
            member.clone(), amount, tx_hash.clone(),
        ).into_val(&env);

        env.set_auths(&[]);
        env.mock_auths(&[
            MockAuth {
                address: &member,
                invoke: &MockAuthInvoke {
                    contract: &settlement_contract_id,
                    fn_name: "record_payment",
                    args: args.clone(),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &attestor,
                invoke: &MockAuthInvoke {
                    contract: &settlement_contract_id,
                    fn_name: "record_payment",
                    args: args.clone(),
                    sub_invokes: &[],
                },
            },
        ]);

        client.record_payment(&trip_id, &expense_id, &payer, &member, &amount, &tx_hash);

        let rec = client.get_payments(&trip_id).get(0).unwrap();
        assert!(rec.attested, "an attestor-cosigned record must be marked attested");
    }

    /// The member alone cannot write a record once an attestor is required.
    #[test]
    #[should_panic]
    fn test_member_alone_cannot_record_when_attestor_set() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);
        let payer = Address::generate(&env);
        let member = Address::generate(&env);

        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);
        client.set_attestor(&attestor);
        pool_client.deposit(&member, &10_000_000_i128);

        let trip_id = String::from_str(&env, "trip-noatt");
        let expense_id = String::from_str(&env, "exp-noatt");
        let tx_hash = String::from_str(&env, "forged12345");
        let amount = 4_000_000_i128;

        env.set_auths(&[]);
        env.mock_auths(&[MockAuth {
            address: &member,
            invoke: &MockAuthInvoke {
                contract: &settlement_contract_id,
                fn_name: "record_payment",
                args: (
                    trip_id.clone(), expense_id.clone(), payer.clone(),
                    member.clone(), amount, tx_hash.clone(),
                ).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.record_payment(&trip_id, &expense_id, &payer, &member, &amount, &tx_hash);
    }

    #[test]
    fn test_migrate_from_v1_to_v2_updates_version() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);

        env.as_contract(&settlement_contract_id, || {
            env.storage().instance().set(&DataKey::Version, &1_u32);
        });

        client.migrate();
        let stored_version: u32 = env
            .as_contract(&settlement_contract_id, || env.storage().instance().get(&DataKey::Version).unwrap());
        assert_eq!(stored_version, 2_u32);
    }

    #[test]
    #[should_panic]
    fn test_set_attestor_requires_admin() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);

        env.set_auths(&[]);
        env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &settlement_contract_id,
                fn_name: "set_attestor",
                args: (attacker.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.set_attestor(&attacker);
    }

    #[test]
    fn test_clear_attestor_returns_to_self_attested() {
        setup!(env, client, pool_client);

        let attestor = Address::generate(&env);
        client.set_attestor(&attestor);
        assert_eq!(client.get_attestor(), Some(attestor));

        client.clear_attestor();
        assert!(client.get_attestor().is_none());

        // Recording works again with member auth alone.
        let trip_id = String::from_str(&env, "trip-cleared");
        let expense_id = String::from_str(&env, "exp-cleared");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        pool_client.deposit(&member, &10_000_000_i128);
        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &1_000_000_i128,
            &String::from_str(&env, "afterclear1"),
        );
        assert!(!client.get_payments(&trip_id).get(0).unwrap().attested);
    }

    #[test]
    fn test_record_payment_works_under_real_auth() {
        let env = Env::default();
        let settlement_contract_id = env.register_contract(None, SettleXContract);
        let pool_contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_contract_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let member = Address::generate(&env);

        env.mock_all_auths();
        pool_client.init_pool(&admin, &settlement_contract_id);
        client.init(&admin, &pool_contract_id);
        pool_client.deposit(&member, &10_000_000_i128);

        let trip_id = String::from_str(&env, "trip-real-auth");
        let expense_id = String::from_str(&env, "exp-real-auth");
        let tx_hash = String::from_str(&env, "abc123def456");
        let amount = 4_000_000_i128;

        // Only the member signs; the settlement contract's authorization of the
        // nested withdraw has to come from the invocation stack itself.
        env.set_auths(&[]);
        env.mock_auths(&[MockAuth {
            address: &member,
            invoke: &MockAuthInvoke {
                contract: &settlement_contract_id,
                fn_name: "record_payment",
                args: (
                    trip_id.clone(),
                    expense_id.clone(),
                    payer.clone(),
                    member.clone(),
                    amount,
                    tx_hash.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.record_payment(&trip_id, &expense_id, &payer, &member, &amount, &tx_hash);

        assert!(client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_record_and_query() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-123");
        let expense_id = String::from_str(&env, "exp-456");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "abc123def456");

        pool_client.deposit(&member, &10_000_000_i128);

        assert!(!client.is_paid(&expense_id, &member));
        assert_eq!(client.get_payments(&trip_id).len(), 0);

        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &10_000_000_i128,
            &tx_hash,
        );

        assert!(client.is_paid(&expense_id, &member));

        let payments = client.get_payments(&trip_id);
        assert_eq!(payments.len(), 1);
        let rec = payments.get(0).unwrap();
        assert_eq!(rec.amount,     10_000_000_i128);
        assert_eq!(rec.expense_id, expense_id);
    }

    #[test]
    fn test_multiple_members() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-multi");
        let expense_id = String::from_str(&env, "exp-multi");
        let payer      = Address::generate(&env);
        let member_a   = Address::generate(&env);
        let member_b   = Address::generate(&env);
        let tx_a       = String::from_str(&env, "hash_a");
        let tx_b       = String::from_str(&env, "hash_b");

        pool_client.deposit(&member_a, &5_000_000_i128);
        pool_client.deposit(&member_b, &7_500_000_i128);

        client.record_payment(&trip_id, &expense_id, &payer, &member_a, &5_000_000_i128, &tx_a);
        client.record_payment(&trip_id, &expense_id, &payer, &member_b, &7_500_000_i128, &tx_b);

        assert!(client.is_paid(&expense_id, &member_a));
        assert!(client.is_paid(&expense_id, &member_b));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    fn test_multiple_expenses_same_trip() {
        setup!(env, client, pool_client);

        let trip_id  = String::from_str(&env, "trip-abc");
        let exp_1    = String::from_str(&env, "exp-001");
        let exp_2    = String::from_str(&env, "exp-002");
        let payer    = Address::generate(&env);
        let member   = Address::generate(&env);
        let tx_1     = String::from_str(&env, "tx_001");
        let tx_2     = String::from_str(&env, "tx_002");

        pool_client.deposit(&member, &7_500_000_i128);

        client.record_payment(&trip_id, &exp_1, &payer, &member, &3_000_000_i128, &tx_1);
        client.record_payment(&trip_id, &exp_2, &payer, &member, &4_500_000_i128, &tx_2);

        assert!(client.is_paid(&exp_1, &member));
        assert!(client.is_paid(&exp_2, &member));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    fn test_trip_payment_history_is_partitioned_by_expense() {
        setup!(env, client, pool_client);

        let trip_id  = String::from_str(&env, "trip-partition");
        let exp_1    = String::from_str(&env, "exp-001");
        let exp_2    = String::from_str(&env, "exp-002");
        let payer    = Address::generate(&env);
        let member   = Address::generate(&env);
        let tx_1     = String::from_str(&env, "tx_001");
        let tx_2     = String::from_str(&env, "tx_002");

        pool_client.deposit(&member, &7_500_000_i128);

        client.record_payment(&trip_id, &exp_1, &payer, &member, &3_000_000_i128, &tx_1);
        client.record_payment(&trip_id, &exp_2, &payer, &member, &4_500_000_i128, &tx_2);

        let payments = client.get_payments(&trip_id);
        assert_eq!(payments.len(), 2);

        let mut seen_expenses = soroban_sdk::Vec::new(&env);
        for payment in payments.iter() {
            assert!(payment.expense_id == exp_1 || payment.expense_id == exp_2);
            seen_expenses.push_back(payment.expense_id.clone());
        }

        assert_eq!(seen_expenses.len(), 2);
        assert!((seen_expenses.get(0).unwrap() == exp_1 && seen_expenses.get(1).unwrap() == exp_2)
            || (seen_expenses.get(0).unwrap() == exp_2 && seen_expenses.get(1).unwrap() == exp_1));
    }

    #[test]
    #[should_panic]
    fn test_duplicate_payment_rejected() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-dup");
        let expense_id = String::from_str(&env, "exp-dup");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_dup");

        pool_client.deposit(&member, &1_000_000_i128);

        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_zero_amount_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-zero");
        let expense_id = String::from_str(&env, "exp-zero");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_zero");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &0_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_negative_amount_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-neg");
        let expense_id = String::from_str(&env, "exp-neg");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_neg");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &-1_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_empty_tx_hash_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-empty-tx");
        let expense_id = String::from_str(&env, "exp-empty-tx");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_i128, &tx_hash);
    }

    /// Advances the ledger sequence, leaving TTL settings intact.
    fn advance_ledgers(env: &Env, by: u32) {
        env.ledger().with_mut(|li| {
            li.sequence_number += by;
        });
    }

    #[test]
    fn test_get_payments_extends_ttl_so_a_read_only_trip_survives() {
        setup!(env, client, pool_client);

        // Keep entries alive only as long as a bump grants, so an un-renewed
        // key is genuinely gone by the time we look for it.
        env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = 1;
            li.max_entry_ttl = STORAGE_BUMP_AMOUNT + 1;
        });

        let trip_id = String::from_str(&env, "trip-read-only");
        let expense_id = String::from_str(&env, "exp-read-only");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-read-only");

        pool_client.deposit(&member, &10_000_000_i128);
        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &10_000_000_i128,
            &tx_hash,
        );

        // A trip written once and then only ever read: step most of the way to
        // expiry, read, and repeat. Each read has to carry the data forward.
        for _ in 0..3 {
            advance_ledgers(&env, STORAGE_BUMP_AMOUNT - 1);
            assert_eq!(
                client.get_payments(&trip_id).len(),
                1,
                "history should survive as long as it keeps being read",
            );
        }
    }

    #[test]
    fn test_is_paid_extends_ttl_so_a_settled_share_stays_settled() {
        setup!(env, client, pool_client);

        env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = 1;
            li.max_entry_ttl = STORAGE_BUMP_AMOUNT + 1;
        });

        let trip_id = String::from_str(&env, "trip-settled");
        let expense_id = String::from_str(&env, "exp-settled");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-settled");

        pool_client.deposit(&member, &10_000_000_i128);
        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &10_000_000_i128,
            &tx_hash,
        );

        // An already-settled share must not read back as unpaid just because
        // nobody wrote to it again.
        for _ in 0..3 {
            advance_ledgers(&env, STORAGE_BUMP_AMOUNT - 1);
            assert!(
                client.is_paid(&expense_id, &member),
                "a settled share should stay settled while it is being read",
            );
        }
    }

    #[test]
    fn test_is_paid_does_not_trap_on_a_missing_entry() {
        setup!(env, client, pool_client);
        let _ = &pool_client;

        // extend_ttl traps on an absent key, so the unpaid path must not bump.
        let expense_id = String::from_str(&env, "exp-never-paid");
        let member = Address::generate(&env);
        assert!(!client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_get_payments_does_not_trap_on_an_unknown_trip() {
        setup!(env, client, pool_client);
        let _ = &pool_client;

        let trip_id = String::from_str(&env, "trip-that-never-existed");
        assert_eq!(client.get_payments(&trip_id).len(), 0);
    }

    #[test]
    fn test_is_paid_unknown_returns_false() {
        setup!(env, client, _pool_client);

        let expense_id = String::from_str(&env, "exp-never");
        let member     = Address::generate(&env);

        assert!(!client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_get_payments_unknown_trip_is_empty() {
        setup!(env, client, _pool_client);

        let trip_id = String::from_str(&env, "trip-ghost");
        assert_eq!(client.get_payments(&trip_id).len(), 0);
    }


    #[test]
    #[should_panic]
    fn test_payer_cannot_equal_member() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-role");
        let expense_id = String::from_str(&env, "exp-role");
        let actor = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-role");

        pool_client.deposit(&actor, &1_000_000_i128);
        client.record_payment(&trip_id, &expense_id, &actor, &actor, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_amount_too_large_rejected() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-big");
        let expense_id = String::from_str(&env, "exp-big");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-big");

        pool_client.deposit(&member, &(MAX_AMOUNT_STROOPS + 1));
        client.record_payment(&trip_id, &expense_id, &payer, &member, &(MAX_AMOUNT_STROOPS + 1), &tx_hash);
    }
}
