import { decodeContractError } from "@/lib/stellar/contract";
import { ContractErrorCode } from "@/types/contract";

describe("decodeContractError", () => {
  it.each([
    [ContractErrorCode.InvalidAmount, "Payment amount must be greater than zero."],
    [ContractErrorCode.AlreadyPaid, "This expense was already settled on-chain. No double payment needed."],
    [ContractErrorCode.EmptyId, "Trip ID or expense ID is missing — cannot record payment."],
    [ContractErrorCode.AlreadyInitialized, "Contract is already initialized."],
    [ContractErrorCode.NotInitialized, "Contract is not initialized yet."],
    [ContractErrorCode.InvalidActor, "Invalid actor for this operation."],
    [ContractErrorCode.IdTooLong, "Trip ID or expense ID is too long."],
    [ContractErrorCode.AmountTooLarge, "Amount is above the allowed limit."],
    [ContractErrorCode.VersionMismatch, "Contract storage version mismatch."],
    [ContractErrorCode.TxHashTooLong, "Transaction hash is too long."],
    [ContractErrorCode.NotPaid, "This expense has not been settled on-chain yet."],
    [ContractErrorCode.Unauthorized, "Authorization failed for this operation."],
    [ContractErrorCode.InvalidPage, "Payment history page size is invalid."],
    [ContractErrorCode.IndexOverflow, "Payment history index is full."],
  ])("maps known code #%s to the expected message", (code, expected) => {
    expect(decodeContractError(`Error(Contract, #${code})`)).toBe(expected);
  });

  it("falls back to numbered generic message for unknown codes", () => {
    const result = decodeContractError("Error(Contract, #99)");
    expect(result).toBe("Contract error #99.");
  });

  it("has no pool-specific mapping: the pool contract was removed (Issue #178)", () => {
    expect(decodeContractError("Error(Contract, #105)")).toBe("Contract error #105.");
  });

  it("returns raw message when pattern is not a contract error", () => {
    const raw = "network timeout";
    expect(decodeContractError(raw)).toBe(raw);
  });

  it("extracts and decodes contract error from longer strings or send messages", () => {
    const msg = "Contract send failed: Error(Contract, #2)";
    expect(decodeContractError(msg)).toBe(
      "This expense was already settled on-chain. No double payment needed."
    );
  });
});
