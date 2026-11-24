import { rpc, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { sorobanServer } from "./soroban";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { logWarn } from "@/lib/observability/logger";
import type { ContractPaymentEvent } from "@/types/contract";
import { getContractPayments } from "./contract";

const LOOKBACK_LEDGERS = 600;

type RawEventLike = {
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  topic?: unknown[];
  value?: unknown;
};

export function parsePaymentEvent(raw: RawEventLike): ContractPaymentEvent | null {
  try {
    const topicScVals = Array.isArray(raw.topic) ? raw.topic : [];
    
    // SDK 1.x returns base64 XDR strings, earlier versions returned parsed objects
    // If it's a string, decode it first.
    const decodeTopic = (val: unknown) => {
      if (typeof val === 'string') return xdr.ScVal.fromXDR(val, 'base64');
      return val as xdr.ScVal;
    };
    
    const eventTripId = topicScVals[1]
      ? String(scValToNative(decodeTopic(topicScVals[1])))
      : "";

    if (!eventTripId) return null;

    const valueNative = raw.value ? scValToNative(decodeTopic(raw.value)) : null;

    let expenseId     = "";
    let member        = "";
    let amountStroops = "0";
    let attested      = false;

    if (Array.isArray(valueNative) && valueNative.length >= 3) {
      expenseId     = String(valueNative[0] ?? "");
      member        = String(valueNative[1] ?? "");
      amountStroops = String(valueNative[2] ?? "0");
      attested      = valueNative[6] === true;
    } else if (valueNative && typeof valueNative === "object") {
      const obj = valueNative as Record<string, unknown>;
      expenseId = String(obj.expense_id ?? obj.expenseId ?? "");
      member = String(obj.member ?? "");
      amountStroops = String(obj.amount ?? obj.amount_stroops ?? "0");
      attested = obj.attested === true;
    }

    return {
      ledger:         Number(raw.ledger ?? 0),
      ledgerClosedAt: String(raw.ledgerClosedAt ?? ""),
      tripId:         eventTripId,
      expenseId,
      member,
      amountStroops,
      txHash:         String(raw.txHash ?? ""),
      attested,
    };
  } catch {
    return null;
  }
}

export async function fetchTripPaymentHistory(
  tripId: string,
  callerPublicKey?: string
): Promise<ContractPaymentEvent[]> {
  if (!CONTRACT_ID || !tripId) {
    return [];
  }

  try {
    const result = await getContractPayments(callerPublicKey ?? "", tripId);
    if (!result.success || !result.payments) {
      if (result.error) {
        logWarn("contract.fetch_trip_history_failed", {
          fields: { tripId, error: result.error },
        });
      }
      return [];
    }

    // Filter out voided records (from clear_paid)
    return result.payments
      .filter((record) => !record.voided)
      .map((record) => ({
        ledger: 0,
        ledgerClosedAt: record.timestamp
          ? new Date(record.timestamp * 1000).toISOString()
          : "",
        tripId: record.tripId,
        expenseId: record.expenseId,
        member: record.member,
        amountStroops: record.amountStroops.toString(),
        txHash: record.txHash,
        attested: record.attested === true,
      }));
  } catch (err) {
    logWarn("contract.fetch_trip_history_failed", {
      fields: {
        tripId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return [];
  }
}

export async function fetchContractEvents(
  startLedger: number,
  tripId?: string,
): Promise<{ events: ContractPaymentEvent[]; latestLedger: number }> {
  if (!CONTRACT_ID) {
    return { events: [], latestLedger: startLedger };
  }

  try {
    let fromLedger = startLedger;

    if (!fromLedger) {
      const latest = await sorobanServer.getLatestLedger();
      fromLedger = Math.max(1, latest.sequence - LOOKBACK_LEDGERS);
    }

    const server = sorobanServer as rpc.Server;

    const symbolXdr = xdr.ScVal.scvSymbol("pmt_rec").toXDR("base64");
    const tripTopicXdr = tripId
      ? nativeToScVal(tripId, { type: "string" }).toXDR("base64")
      : "*";

    let cursor: string | undefined = undefined;
    let latestLedger = fromLedger;
    const allRawEvents: RawEventLike[] = [];
    const MAX_PAGES = 50;

    for (let page = 0; page < MAX_PAGES; page++) {
      const requestParams: {
        filters: Array<{
          type: "contract";
          contractIds: string[];
          topics: string[][];
        }>;
        limit: number;
        startLedger?: number;
        cursor?: string;
      } = {
        filters: [
          {
            type:        "contract",
            contractIds: [CONTRACT_ID],
            topics:      [[symbolXdr, tripTopicXdr]],
          },
        ],
        limit: 200,
      };

      if (cursor) {
        requestParams.cursor = cursor;
      } else {
        requestParams.startLedger = fromLedger;
      }

      const response = (await server.getEvents(requestParams)) as rpc.Api.GetEventsResponse & {
        cursor?: string;
      };

      if (typeof response?.latestLedger === "number" && response.latestLedger > latestLedger) {
        latestLedger = response.latestLedger;
      }

      const pageEvents = Array.isArray(response?.events) ? response.events : [];
      allRawEvents.push(...pageEvents);

      const nextCursor: string | undefined =
        response?.cursor ??
        (pageEvents.length > 0
          ? (pageEvents[pageEvents.length - 1] as { pagingToken?: string })?.pagingToken
          : undefined);

      if (pageEvents.length < 200 || !nextCursor || nextCursor === cursor) {
        break;
      }

      cursor = nextCursor;
    }

    const events: ContractPaymentEvent[] = allRawEvents
      .map((ev) => parsePaymentEvent(ev))
      .filter((e): e is ContractPaymentEvent => e !== null && !!e.tripId);

    return { events, latestLedger };
  } catch (err) {
    // Rethrown for the caller to handle; logged here because this is the layer
    // that knows the RPC call failed, and a sustained spike means the Soroban
    // RPC is down.
    logWarn("contract.fetch_events_failed", {
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
