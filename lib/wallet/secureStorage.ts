export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

export interface StoredWallet {
  address: string;
  secret: string;
}

interface StoredWalletRecord {
  pinHash: string;
  wallet: StoredWallet;
}

export type WalletResult<T> =
  | { status: "ok"; value: T }
  | { status: "storage-error"; error: unknown };

export type PinVerificationResult =
  | { status: "verified"; wallet: StoredWallet; attemptsRemaining: number }
  | {
      status: "incorrect-pin";
      attemptsRemaining: number;
      locked: boolean;
    }
  | { status: "storage-error"; error: unknown };

export const WALLET_STORAGE_KEY = "settlex:wallet-vault";
export const DEFAULT_MAX_PIN_ATTEMPTS = 5;

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseRecord(raw: string): StoredWalletRecord {
  const record = JSON.parse(raw) as Partial<StoredWalletRecord>;
  if (
    typeof record.pinHash !== "string" ||
    !record.wallet ||
    typeof record.wallet.address !== "string" ||
    typeof record.wallet.secret !== "string"
  ) {
    throw new Error("Stored wallet data is invalid.");
  }
  return record as StoredWalletRecord;
}

export class WalletVault {
  private failedAttempts = 0;

  constructor(
    private readonly storage: SecureStorage,
    private readonly storageKey = WALLET_STORAGE_KEY,
    private readonly maxAttempts = DEFAULT_MAX_PIN_ATTEMPTS,
  ) {}

  async getWallet(): Promise<WalletResult<StoredWallet | null>> {
    try {
      const raw = await this.storage.getItem(this.storageKey);
      return { status: "ok", value: raw ? parseRecord(raw).wallet : null };
    } catch (error) {
      return { status: "storage-error", error };
    }
  }

  async verifyPin(pin: string): Promise<PinVerificationResult> {
    if (this.failedAttempts >= this.maxAttempts) {
      return {
        status: "incorrect-pin",
        attemptsRemaining: 0,
        locked: true,
      };
    }

    let record: StoredWalletRecord;
    try {
      const raw = await this.storage.getItem(this.storageKey);
      if (!raw) {
        return { status: "storage-error", error: new Error("Wallet not found.") };
      }
      record = parseRecord(raw);
    } catch (error) {
      return { status: "storage-error", error };
    }

    let matches: boolean;
    try {
      matches = (await hashPin(pin)) === record.pinHash;
    } catch (error) {
      return { status: "storage-error", error };
    }

    if (!matches) {
      this.failedAttempts += 1;
      const attemptsRemaining = Math.max(this.maxAttempts - this.failedAttempts, 0);
      return {
        status: "incorrect-pin",
        attemptsRemaining,
        locked: attemptsRemaining === 0,
      };
    }

    this.failedAttempts = 0;
    return {
      status: "verified",
      wallet: record.wallet,
      attemptsRemaining: this.maxAttempts,
    };
  }
}

export function walletResultMessage(
  result: PinVerificationResult | WalletResult<StoredWallet | null>,
): string | null {
  switch (result.status) {
    case "storage-error":
      return "Could not access secure storage. Please try again.";
    case "incorrect-pin":
      return result.locked
        ? "Too many incorrect PIN attempts. Try again later."
        : "Incorrect PIN.";
    default:
      return null;
  }
}