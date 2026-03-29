use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PoolError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,
    BalanceOverflow = 6,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolConfig {
    pub admin: Address,
    pub settlement_contract: Address,
}

#[contracttype]
pub enum PoolDataKey {
    Config,
    Balance(Address),
}

const LEDGERS_PER_DAY: u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT: u32 = LEDGERS_PER_DAY * 365;

#[contract]
pub struct SettlementPoolContract;

#[contractimpl]
impl SettlementPoolContract {
    pub fn init(env: Env, admin: Address, settlement_contract: Address) {
        if env.storage().instance().has(&PoolDataKey::Config) {
            panic_with_error!(&env, PoolError::AlreadyInitialized);
        }

        admin.require_auth();

        let cfg = PoolConfig {
            admin,
            settlement_contract,
        };

        env.storage().instance().set(&PoolDataKey::Config, &cfg);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(symbol_short!("pool_ini"), true);
    }

    pub fn get_config(env: Env) -> PoolConfig {
        let cfg = env.storage()
            .instance()
            .get(&PoolDataKey::Config)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        cfg
    }

    pub fn set_settlement_contract(env: Env, new_contract: Address) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();

        cfg.settlement_contract = new_contract;
        env.storage().instance().set(&PoolDataKey::Config, &cfg);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(symbol_short!("pool_cfg"), cfg.settlement_contract);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, PoolError::InvalidAmount);
        }

        // Ensure pool is initialized before accepting funds.
        let _cfg = Self::get_config(env.clone());

        from.require_auth();

        let key = PoolDataKey::Balance(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0_i128);
        let next = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::BalanceOverflow));
        env.storage().persistent().set(&key, &next);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("pool_dep"), from), amount);
    }

    pub fn withdraw(env: Env, from: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, PoolError::InvalidAmount);
        }

        // Ensure pool is initialized before allowing balance operations.
        let _cfg = Self::get_config(env.clone());

        from.require_auth();

        let key = PoolDataKey::Balance(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0_i128);

        if current < amount {
            panic_with_error!(&env, PoolError::InsufficientBalance);
        }

        let next = current - amount;
        env.storage().persistent().set(&key, &next);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("pool_wdr"), from), amount);
    }

    pub fn balance_of(env: Env, member: Address) -> i128 {
        let _cfg = Self::get_config(env.clone());

        let key = PoolDataKey::Balance(member);
        let balance = env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(0_i128);

        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        balance
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    macro_rules! setup_pool {
        ($env:ident, $client:ident, $admin:ident, $settlement:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettlementPoolContractClient::new(&$env, &contract_id);
            let $admin = Address::generate(&$env);
            let $settlement = Address::generate(&$env);
        };
    }

    #[test]
    fn test_init_and_get_config() {
        setup_pool!(env, client, admin, settlement_contract);

        client.init(&admin, &settlement_contract);
        let cfg = client.get_config();

        assert_eq!(cfg.admin, admin);
        assert_eq!(cfg.settlement_contract, settlement_contract);
    }

    #[test]
    #[should_panic]
    fn test_double_init_rejected() {
        setup_pool!(env, client, admin, settlement_contract);

        client.init(&admin, &settlement_contract);
        client.init(&admin, &settlement_contract);
    }

    #[test]
    fn test_deposit_and_balance() {
        setup_pool!(env, client, admin, settlement_contract);

        let member = Address::generate(&env);
        client.init(&admin, &settlement_contract);

        client.deposit(&member, &1_500_000_i128);
        assert_eq!(client.balance_of(&member), 1_500_000_i128);
    }

    #[test]
    fn test_withdraw_reduces_balance() {
        setup_pool!(env, client, admin, settlement_contract);

        let member = Address::generate(&env);
        client.init(&admin, &settlement_contract);

        client.deposit(&member, &2_000_000_i128);
        client.withdraw(&member, &700_000_i128);

        assert_eq!(client.balance_of(&member), 1_300_000_i128);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_insufficient_rejected() {
        setup_pool!(env, client, admin, settlement_contract);

        let member = Address::generate(&env);
        client.init(&admin, &settlement_contract);

        client.deposit(&member, &100_000_i128);
        client.withdraw(&member, &200_000_i128);
    }

    #[test]
    fn test_update_settlement_contract() {
        setup_pool!(env, client, admin, settlement_contract);

        let next_contract = Address::generate(&env);
        client.init(&admin, &settlement_contract);
        client.set_settlement_contract(&next_contract);

        let cfg = client.get_config();
        assert_eq!(cfg.settlement_contract, next_contract);
    }

    #[test]
    #[should_panic]
    fn test_deposit_requires_init() {
        setup_pool!(env, client, _admin, _settlement_contract);

        let member = Address::generate(&env);
        client.deposit(&member, &1_i128);
    }
}
