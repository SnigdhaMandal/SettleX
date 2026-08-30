import {
  WalletVault,
  walletResultMessage,
  type SecureStorage,
} from "@/lib/wallet/secureStorage";

function storage(value: string | null): SecureStorage {
  return {
    getItem: jest.fn().mockResolvedValue(value),
    setItem: jest.fn().mockResolvedValue(undefined),
  };
}

describe("WalletVault", () => {
  it("returns the wallet on a correct PIN", async () => {
    const store = storage(
      JSON.stringify({
        pinHash: await awaitHash("1234"),
        wallet: { address: "GADDRESS", secret: "SSECRET" },
      }),
    );
    const vault = new WalletVault(store);

    await expect(vault.verifyPin("1234")).resolves.toMatchObject({
      status: "verified",
      wallet: { address: "GADDRESS" },
    });
  });

  it("does not count storage failures as incorrect PIN attempts", async () => {
    const store: SecureStorage = {
      getItem: jest.fn().mockRejectedValue(new Error("storage unavailable")),
      setItem: jest.fn(),
    };
    const vault = new WalletVault(store);

    await expect(vault.verifyPin("wrong")).resolves.toMatchObject({
      status: "storage-error",
    });
    (store.getItem as jest.Mock).mockResolvedValue(
      JSON.stringify({
        pinHash: await awaitHash("1234"),
        wallet: { address: "GADDRESS", secret: "SSECRET" },
      }),
    );
    await expect(vault.verifyPin("wrong")).resolves.toMatchObject({
      status: "incorrect-pin",
      attemptsRemaining: 4,
    });
  });

  it("maps storage and PIN failures to different UI messages", () => {
    expect(
      walletResultMessage({ status: "storage-error", error: new Error() }),
    ).toContain("secure storage");
    expect(
      walletResultMessage({
        status: "incorrect-pin",
        attemptsRemaining: 4,
        locked: false,
      }),
    ).toBe("Incorrect PIN.");
  });
});

async function awaitHash(pin: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pin),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

