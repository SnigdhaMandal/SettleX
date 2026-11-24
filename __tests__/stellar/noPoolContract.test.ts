import * as fs from "fs";
import * as path from "path";

/**
 * Issue #178: the docs claimed `record_payment` withdraws from a pool contract
 * in the same transaction, but the code never did. The pool was removed, and
 * this suite keeps code, tests and docs describing the same behaviour.
 */
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

describe("Issue #178: record_payment is a single-contract ledger write", () => {
  const settlement = read("contract/contracts/settlement/src/lib.rs");

  it("the pool contract crate no longer exists", () => {
    expect(fs.existsSync(path.resolve(root, "contract/contracts/pool"))).toBe(false);
    expect(read("contract/Cargo.toml")).not.toMatch(/contracts\/pool/);
    expect(read("contract/contracts/settlement/Cargo.toml")).not.toMatch(/settlement-pool-contract/);
  });

  it("the settlement contract has no pool wiring", () => {
    expect(settlement).not.toMatch(/PoolContract/);
    expect(settlement).not.toMatch(/fn set_pool_contract|fn get_pool_contract/);
    expect(settlement).not.toMatch(/PoolClient|SettlementPoolContract/);
    expect(settlement).not.toMatch(/pool_client\.deposit/);
  });

  it("ships a contract test asserting record_payment makes no nested call", () => {
    expect(settlement).toMatch(/fn test_record_payment_makes_no_cross_contract_call\(\)/);
    expect(settlement).toMatch(/sub_invocations\.is_empty\(\)/);
  });

  it("the client no longer exposes a pool balance precheck or pool errors", () => {
    expect(read("lib/stellar/contract.ts")).not.toMatch(/precheckPoolBalance|PoolErrorCode/);
    expect(read("types/contract.ts")).not.toMatch(/PoolErrorCode/);
  });

  it.each([
    "README.md",
    "docs/REQUIREMENT_PROOF_MATRIX.md",
    "docs/ARCHITECTURE_AND_LIMITATIONS.md",
    "docs/RUNBOOK.md",
  ])("%s does not claim record_payment calls the pool", (doc) => {
    const text = read(doc);
    expect(text).not.toMatch(/credits can only (ever )?be consumed/i);
    expect(text).not.toMatch(/set_pool_contract|get_pool_contract/);
    // The old "proof" transaction must not be linked as evidence.
    expect(text).not.toMatch(/tx\/04c679c7/);
  });
});
