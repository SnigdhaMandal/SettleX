/** @jest-environment jsdom */

import { renderHook, waitFor, act } from "@testing-library/react";

const getEventsMock = jest.fn();
const getLatestLedgerMock = jest.fn();
const simulateTransactionMock = jest.fn();

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    getEvents: (...args: unknown[]) => getEventsMock(...args),
    getLatestLedger: (...args: unknown[]) => getLatestLedgerMock(...args),
    simulateTransaction: (...args: unknown[]) => simulateTransactionMock(...args),
  },
}));

jest.mock("@/lib/observability/logger", () => ({
  logWarn: jest.fn(),
  reportError: jest.fn(),
}));

jest.mock("@/lib/utils/constants", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
}));

import { useContractEvents } from "@/hooks/useContractEvents";
import { fetchContractEvents, fetchTripPaymentHistory } from "@/lib/stellar/events";
import * as eventsModule from "@/lib/stellar/events";

describe("useContractEvents trip isolation and pagination (#212)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getLatestLedgerMock.mockResolvedValue({ sequence: 1000 });
  });

  describe("tripId switching and state isolation", () => {
    it("switching tripId shows no carried-over events from the previous trip", async () => {
      const tripAEvent = {
        ledger: 101,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        tripId: "trip-A",
        expenseId: "exp-A",
        member: "GA_DEBTOR",
        amountStroops: "1000",
        txHash: "hash-trip-A",
        attested: true,
      };

      const tripBEvent = {
        ledger: 102,
        ledgerClosedAt: "2024-01-02T00:00:00Z",
        tripId: "trip-B",
        expenseId: "exp-B",
        member: "GB_DEBTOR",
        amountStroops: "2000",
        txHash: "hash-trip-B",
        attested: true,
      };

      jest.spyOn(eventsModule, "fetchTripPaymentHistory").mockImplementation(async (tId: string) => {
        if (tId === "trip-A") return [tripAEvent];
        if (tId === "trip-B") return [tripBEvent];
        return [];
      });

      jest.spyOn(eventsModule, "fetchContractEvents").mockResolvedValue({
        events: [],
        latestLedger: 1000,
      });

      const { result, rerender } = renderHook(
        ({ tripId }: { tripId: string }) => useContractEvents(tripId),
        {
          initialProps: { tripId: "trip-A" },
        }
      );

      await waitFor(() => {
        expect(result.current.events).toEqual([tripAEvent]);
      });

      // Switch to Trip B
      rerender({ tripId: "trip-B" });

      await waitFor(() => {
        expect(result.current.events).toEqual([tripBEvent]);
      });

      // Verify Trip A's event is completely absent
      const hasTripA = result.current.events.some((e) => e.tripId === "trip-A" || e.txHash === "hash-trip-A");
      expect(hasTripA).toBe(false);
    });
  });

  describe("fetchTripPaymentHistory voided records filter", () => {
    it("filters out voided records from get_payments", async () => {
      simulateTransactionMock.mockResolvedValue({
        result: {
          retval: {
            switch: () => ({ name: "scvMap" }),
            value: () => [],
          },
        },
      });

      const mockGetContractPayments = jest.spyOn(
        require("@/lib/stellar/contract"),
        "getContractPayments"
      ).mockResolvedValue({
        success: true,
        payments: [
          {
            tripId: "trip-1",
            expenseId: "exp-valid",
            payer: "G_CREDITOR",
            member: "G_DEBTOR",
            amountStroops: BigInt(5000),
            txHash: "tx-valid",
            timestamp: 1700000000,
            attested: true,
            voided: false,
          },
          {
            tripId: "trip-1",
            expenseId: "exp-voided",
            payer: "G_CREDITOR",
            member: "G_DEBTOR",
            amountStroops: BigInt(2000),
            txHash: "tx-voided",
            timestamp: 1700000100,
            attested: false,
            voided: true,
          },
        ],
      });

      const history = await fetchTripPaymentHistory("trip-1");

      expect(history.length).toBe(1);
      expect(history[0].txHash).toBe("tx-valid");
      expect(history[0].expenseId).toBe("exp-valid");
    });
  });

  describe("cursor pagination in fetchContractEvents", () => {
    it("follows pagination cursor when events exceed limit", async () => {
      // First page returns 200 events and a cursor
      const page1Events = Array.from({ length: 200 }, (_, i) => ({
        ledger: 100,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        txHash: `hash-page1-${i}`,
        topic: ["pmt_rec", "trip-1"],
        value: [`exp-${i}`, "GDEBTOR", "1000"],
      }));

      // Second page returns 50 events and no cursor
      const page2Events = Array.from({ length: 50 }, (_, i) => ({
        ledger: 101,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        txHash: `hash-page2-${i}`,
        topic: ["pmt_rec", "trip-1"],
        value: [`exp-2-${i}`, "GDEBTOR", "1000"],
      }));

      // Mock parsePaymentEvent via eventsParser
      jest.spyOn(eventsModule, "parsePaymentEvent").mockImplementation((raw: any) => ({
        ledger: raw.ledger,
        ledgerClosedAt: raw.ledgerClosedAt,
        tripId: "trip-1",
        expenseId: raw.value[0],
        member: raw.value[1],
        amountStroops: raw.value[2],
        txHash: raw.txHash,
        attested: false,
      }));

      getEventsMock
        .mockResolvedValueOnce({
          events: page1Events,
          latestLedger: 100,
          cursor: "cursor-token-page-1",
        })
        .mockResolvedValueOnce({
          events: page2Events,
          latestLedger: 101,
          cursor: undefined,
        });

      const result = await fetchContractEvents(100, "trip-1");

      expect(getEventsMock).toHaveBeenCalledTimes(2);
      expect(result.events.length).toBe(250);
      expect(result.latestLedger).toBe(101);
    });
  });
});
