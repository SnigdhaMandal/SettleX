#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, panic_with_error, symbol_short,
    Address, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    InvalidAmount = 1,
    AlreadyPaid   = 2,
    EmptyId       = 3,
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
}

#[contracttype]
pub enum DataKey {
    TripPayments(String),
    ExpensePaid(String, Address),
}

const LEDGERS_PER_DAY:        u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT:    u32 = LEDGERS_PER_DAY * 365;

#[contract]
pub struct SettleXContract;

#[contractimpl]
impl SettleXContract {

   
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
        if trip_id.len() == 0 || expense_id.len() == 0 {
            panic_with_error!(&env, ContractError::EmptyId);
        }

        let paid_key = DataKey::ExpensePaid(expense_id.clone(), member.clone());
        if env.storage().persistent().has(&paid_key) {
            panic_with_error!(&env, ContractError::AlreadyPaid);
        }

        let record = PaymentRecord {
            expense_id: expense_id.clone(),
            payer,
            member:    member.clone(),
            amount,
            tx_hash,
            timestamp: env.ledger().timestamp(),
        };

        let trip_key = DataKey::TripPayments(trip_id.clone());
        let mut payments: Vec<PaymentRecord> = env
            .storage()
            .persistent()
            .get(&trip_key)
            .unwrap_or_else(|| Vec::new(&env));
        payments.push_back(record);
        env.storage().persistent().set(&trip_key, &payments);
        env.storage()
            .persistent()
            .extend_ttl(&trip_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.storage().persistent().set(&paid_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&paid_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pmt_rec"), trip_id),
            (expense_id, member, amount),
        );
    }

    pub fn get_payments(env: Env, trip_id: String) -> Vec<PaymentRecord> {
        let key = DataKey::TripPayments(trip_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn is_paid(env: Env, expense_id: String, member: Address) -> bool {
        let key = DataKey::ExpensePaid(expense_id, member);
        env.storage().persistent().has(&key)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    macro_rules! setup {
        ($env:ident, $client:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let contract_id = $env.register_contract(None, SettleXContract);
            let $client     = SettleXContractClient::new(&$env, &contract_id);
        };
    }

    #[test]
    fn test_record_and_query() {
        setup!(env, client);

        let trip_id    = String::from_str(&env, "trip-123");
        let expense_id = String::from_str(&env, "exp-456");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "abc123def456");

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
        setup!(env, client);

        let trip_id    = String::from_str(&env, "trip-multi");
        let expense_id = String::from_str(&env, "exp-multi");
        let payer      = Address::generate(&env);
        let member_a   = Address::generate(&env);
        let member_b   = Address::generate(&env);
        let tx_a       = String::from_str(&env, "hash_a");
        let tx_b       = String::from_str(&env, "hash_b");

        client.record_payment(&trip_id, &expense_id, &payer, &member_a, &5_000_000_i128, &tx_a);
        client.record_payment(&trip_id, &expense_id, &payer, &member_b, &7_500_000_i128, &tx_b);

        assert!(client.is_paid(&expense_id, &member_a));
        assert!(client.is_paid(&expense_id, &member_b));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    fn test_multiple_expenses_same_trip() {
        setup!(env, client);

        let trip_id  = String::from_str(&env, "trip-abc");
        let exp_1    = String::from_str(&env, "exp-001");
        let exp_2    = String::from_str(&env, "exp-002");
        let payer    = Address::generate(&env);
        let member   = Address::generate(&env);
        let tx_1     = String::from_str(&env, "tx_001");
        let tx_2     = String::from_str(&env, "tx_002");

        client.record_payment(&trip_id, &exp_1, &payer, &member, &3_000_000_i128, &tx_1);
        client.record_payment(&trip_id, &exp_2, &payer, &member, &4_500_000_i128, &tx_2);

        assert!(client.is_paid(&exp_1, &member));
        assert!(client.is_paid(&exp_2, &member));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    #[should_panic]
    fn test_duplicate_payment_rejected() {
        setup!(env, client);

        let trip_id    = String::from_str(&env, "trip-dup");
        let expense_id = String::from_str(&env, "exp-dup");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_dup");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_zero_amount_rejected() {
        setup!(env, client);

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
        setup!(env, client);

        let trip_id    = String::from_str(&env, "trip-neg");
        let expense_id = String::from_str(&env, "exp-neg");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_neg");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &-1_i128, &tx_hash);
    }

    #[test]
    fn test_is_paid_unknown_returns_false() {
        setup!(env, client);

        let expense_id = String::from_str(&env, "exp-never");
        let member     = Address::generate(&env);

        assert!(!client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_get_payments_unknown_trip_is_empty() {
        setup!(env, client);

        let trip_id = String::from_str(&env, "trip-ghost");
        assert_eq!(client.get_payments(&trip_id).len(), 0);
    }
}
