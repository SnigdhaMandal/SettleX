const isConnectedMock = jest.fn();
const openModalMock = jest.fn();
const setWalletMock = jest.fn();
const getAddressMock = jest.fn();
const signTransactionMock = jest.fn();
const getNetworkFromWalletMock = jest.fn();

jest.mock("@stellar/freighter-api", () => ({
  isConnected: (...args: unknown[]) => isConnectedMock(...args),
}));

jest.mock("@/lib/stellar/walletsKit", () => ({
  getWalletsKit: () => ({
    openModal: (...args: unknown[]) => openModalMock(...args),
    setWallet: (...args: unknown[]) => setWalletMock(...args),
    getAddress: (...args: unknown[]) => getAddressMock(...args),
    signTransaction: (...args: unknown[]) => signTransactionMock(...args),
    getNetworkFromWallet: (...args: unknown[]) => getNetworkFromWalletMock(...args),
  }),
}));

import {
  isFreighterInstalled,
  connectFreighter,
  signXDR,
  getFreighterNetwork,
  verifySignedTxNetwork,
} from "@/lib/freighter";

describe("freighter helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.resetAllMocks();
  });

  it("returns false when window is undefined", async () => {
    const originalWindow = (global as any).window;
    delete (global as any).window;
    const res = await isFreighterInstalled();
    (global as any).window = originalWindow;
    expect(res).toBe(false);
  });

  it("returns true when freighter reports connected", async () => {
    (global as any).window = {};
    isConnectedMock.mockResolvedValue({ error: null, isConnected: true });

    await expect(isFreighterInstalled()).resolves.toBe(true);
  });

  it("connectFreighter resolves selected wallet address", async () => {
    getAddressMock.mockResolvedValue({ address: "GTESTADDRESS" });
    openModalMock.mockImplementation(async (opts: any) => {
      await opts.onWalletSelected({ id: "freighter" });
    });

    await expect(connectFreighter()).resolves.toBe("GTESTADDRESS");
    expect(setWalletMock).toHaveBeenCalledWith("freighter");
  });

  it("signXDR throws on empty signed payload", async () => {
    signTransactionMock.mockResolvedValue({ signedTxXdr: "" });

    await expect(signXDR("ABC")).rejects.toThrow(
      "The wallet returned an empty signed transaction.",
    );
  });

  it("signXDR passes connected address to signTransaction", async () => {
    signTransactionMock.mockResolvedValue({ signedTxXdr: "ABC_SIGNED" });

    const res = await signXDR("ABC", "Test SDF Network ; September 2015", "GTESTADDRESS");
    expect(res).toBe("ABC_SIGNED");
    expect(signTransactionMock).toHaveBeenCalledWith("ABC", {
      address: "GTESTADDRESS",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });

  it("signXDR falls back to localStorage address when address param is omitted", async () => {
    localStorage.setItem("settlex:publicKey", "GSTOREDADDRESS");
    signTransactionMock.mockResolvedValue({ signedTxXdr: "ABC_SIGNED" });

    const res = await signXDR("ABC", "Test SDF Network ; September 2015");
    expect(res).toBe("ABC_SIGNED");
    expect(signTransactionMock).toHaveBeenCalledWith("ABC", {
      address: "GSTOREDADDRESS",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });

  it("verifySignedTxNetwork returns false for invalid or empty inputs", () => {
    expect(verifySignedTxNetwork("", "GTESTADDRESS")).toBe(false);
    expect(verifySignedTxNetwork("NOT_AN_XDR", "INVALID_KEY")).toBe(false);
  });

  it("does not disguise a failed network read as TESTNET", async () => {
    getNetworkFromWalletMock.mockRejectedValue(new Error("boom"));

    await expect(getFreighterNetwork()).rejects.toThrow("boom");
  });
});
