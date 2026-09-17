import axios from "axios";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  enqueueHotelBookingEmail,
  getSessionId,
  isHotelSupplierConfirmed,
} from "./helper.js";
import { parseStoredPromo } from "./hotelPromoBind.js";
import { redeemMarkupsPromo } from "./markupsPromoClient.js";
import {
  HOTEL_PENDING_POLL_STATUSES,
  acquireHotelPollLock,
  chunkArray,
  enqueuePendingHotelPoll,
  fetchDuePendingPolls,
  getPollConfig,
  isHotelPendingPollStatus,
  isHotelTerminalStopStatus,
  releaseHotelPollLock,
  removePendingHotelPoll,
  reschedulePendingHotelPoll,
  updatePendingPollPayload,
} from "./hotelPendingPoll.js";

const BASE_URL = process.env.BASE_URL;

const normalizeStatus = (status) => String(status || "").trim();

const statusesEqual = (a, b) =>
  normalizeStatus(a).toUpperCase() === normalizeStatus(b).toUpperCase();

export const loadStoredBooking = async (dynamo, bookingReferenceId, hotelKey) => {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: process.env.HOTEL_BOOK_TABLE,
      Key: {
        bookingReferenceId: { S: String(bookingReferenceId) },
        hotelKey: { S: String(hotelKey) },
      },
    })
  );
  return result.Item ? unmarshall(result.Item) : null;
};

const retrieveFromSupplier = async (payload, sessionId, conversationId) => {
  const body = {
    productType: "H",
    bookingReferenceId: payload.bookingReferenceId,
    clientReferenceId: payload.clientReferenceId || "",
    bookingKey: payload.bookingKey || "",
    searchKey: payload.searchKey || "",
  };
  const resp = await axios.post(`${BASE_URL}/reservation/hotel-book-retrieve`, body, {
    timeout: 45000,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.X_API_KEY,
      conversationId,
      sessionId,
    },
  });
  return resp.data?.data?.[0] || null;
};

const buildEmailBookingData = (supplierData, stored, payload) => {
  let storedPassengers = stored?.passengers;
  if (typeof storedPassengers === "string") {
    try {
      storedPassengers = JSON.parse(storedPassengers);
    } catch {
      storedPassengers = [];
    }
  }
  let storedHotel = stored?.hotel;
  if (typeof storedHotel === "string") {
    try {
      storedHotel = JSON.parse(storedHotel);
    } catch {
      storedHotel = {};
    }
  }
  const promo = parseStoredPromo(stored?.promo);
  const mergedHotel = {
    ...(supplierData?.hotel || {}),
    ...(storedHotel || {}),
    hotelKey:
      storedHotel?.hotelKey ||
      supplierData?.hotel?.hotelKey ||
      payload.hotelKey,
    passengers:
      storedHotel?.passengers ||
      supplierData?.hotel?.passengers ||
      supplierData?.passengers ||
      storedPassengers ||
      [],
  };
  if (storedHotel?.totalNet != null) mergedHotel.totalNet = storedHotel.totalNet;
  return {
    data: [{
      ...supplierData,
      hotel: mergedHotel,
      promo: promo || undefined,
    }],
  };
};

export const markHotelConfirmationEmailQueued = async (
  dynamo,
  bookingReferenceId,
  hotelKey
) => {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateItemCommand({
      TableName: process.env.HOTEL_BOOK_TABLE,
      Key: {
        bookingReferenceId: { S: String(bookingReferenceId) },
        hotelKey: { S: String(hotelKey) },
      },
      UpdateExpression: "SET confirmationEmailQueuedAt = :eqa, updatedAt = :u",
      ConditionExpression: "attribute_not_exists(confirmationEmailQueuedAt)",
      ExpressionAttributeValues: {
        ":eqa": { S: now },
        ":u": { S: now },
      },
    })
  );
  return true;
};

const maybeQueueConfirmationEmail = async ({
  dynamo,
  supplierData,
  stored,
  payload,
}) => {
  if (!isHotelSupplierConfirmed(supplierData?.bookingStatus)) return { queued: false };

  if (stored?.confirmationEmailQueuedAt) {
    return { queued: false, reason: "already_queued" };
  }

  const promo = parseStoredPromo(stored?.promo);
  if (promo?.code) {
    try {
      const redeemed = await redeemMarkupsPromo({
        code: promo.code,
        userId: payload.userId || stored?.userId,
        bookingId: payload.bookingReferenceId,
        discount: promo.discount,
        payable: promo.payable,
        listedPrice: promo.listedPrice,
      });
      if (!redeemed.ok) {
        console.warn("[HOTEL PROMO] pending redeem failed", redeemed.message);
      }
    } catch (err) {
      console.warn("[HOTEL PROMO] pending redeem error", err?.message);
    }
  }

  try {
    await markHotelConfirmationEmailQueued(
      dynamo,
      payload.bookingReferenceId,
      payload.hotelKey
    );
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return { queued: false, reason: "already_queued_race" };
    }
    throw err;
  }

  await enqueueHotelBookingEmail({
    hotelBookingData: buildEmailBookingData(supplierData, stored, payload),
    userId: payload.userId || stored?.userId,
    userType: payload.userType || stored?.userType,
  });
  return { queued: true };
};

const updateBookingStatus = async ({
  dynamo,
  bookingReferenceId,
  hotelKey,
  expectedStatus,
  newStatus,
  extra = {},
}) => {
  const now = new Date().toISOString();
  const escalateSupplierFlag = !isHotelSupplierConfirmed(newStatus);
  const names = { "#bs": "bookingStatus", "#esf": "escalateSupplierFlag" };
  const values = {
    ":newStatus": { S: normalizeStatus(newStatus) },
    ":expected": { S: normalizeStatus(expectedStatus) },
    ":esf": { BOOL: escalateSupplierFlag },
    ":u": { S: now },
    ":checked": { S: now },
  };
  let updateExpression =
    "SET #bs = :newStatus, #esf = :esf, updatedAt = :u, statusLastCheckedAt = :checked";

  if (extra.statusPollingStoppedAt) {
    names["#sps"] = "statusPollingStoppedAt";
    values[":sps"] = { S: extra.statusPollingStoppedAt };
    updateExpression += ", #sps = :sps";
  }
  if (extra.statusPollingStopReason) {
    names["#spr"] = "statusPollingStopReason";
    values[":spr"] = { S: extra.statusPollingStopReason };
    updateExpression += ", #spr = :spr";
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: process.env.HOTEL_BOOK_TABLE,
      Key: {
        bookingReferenceId: { S: String(bookingReferenceId) },
        hotelKey: { S: String(hotelKey) },
      },
      UpdateExpression: updateExpression,
      ConditionExpression: "#bs = :expected",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
};

const isMaxAgeExceeded = (payload) => {
  const { pollMaxAgeMs } = getPollConfig();
  const enqueuedAt = Date.parse(payload.enqueuedAt || "");
  if (!Number.isFinite(enqueuedAt)) return false;
  return Date.now() - enqueuedAt >= pollMaxAgeMs;
};

export const processPendingHotelPollItem = async ({
  dynamo,
  member,
  payload,
  sessionId,
  conversationId,
}) => {
  const result = {
    member,
    bookingReferenceId: payload.bookingReferenceId,
    outcome: "unknown",
  };

  if (isMaxAgeExceeded(payload)) {
    await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
    try {
      const stored = await loadStoredBooking(
        dynamo,
        payload.bookingReferenceId,
        payload.hotelKey
      );
      if (stored && isHotelPendingPollStatus(stored.bookingStatus)) {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: process.env.HOTEL_BOOK_TABLE,
            Key: {
              bookingReferenceId: { S: String(payload.bookingReferenceId) },
              hotelKey: { S: String(payload.hotelKey) },
            },
            UpdateExpression:
              "SET statusPollingStoppedAt = :s, statusPollingStopReason = :r, updatedAt = :u",
            ExpressionAttributeValues: {
              ":s": { S: new Date().toISOString() },
              ":r": { S: "MAX_AGE" },
              ":u": { S: new Date().toISOString() },
            },
          })
        );
      }
    } catch (err) {
      console.warn("Max-age DB flag failed:", payload.bookingReferenceId, err?.message);
    }
    result.outcome = "max_age_stopped";
    return result;
  }

  let supplierData;
  try {
    supplierData = await retrieveFromSupplier(payload, sessionId, conversationId);
  } catch (err) {
    const retryCount = Number(payload.retryCount || 0) + 1;
    await reschedulePendingHotelPoll(member, payload, retryCount);
    result.outcome = "supplier_error";
    result.error = err?.response?.data || err?.message;
    return result;
  }

  if (!supplierData?.bookingStatus) {
    const retryCount = Number(payload.retryCount || 0) + 1;
    await reschedulePendingHotelPoll(member, payload, retryCount);
    result.outcome = "invalid_supplier_response";
    return result;
  }

  const supplierStatus = normalizeStatus(supplierData.bookingStatus);
  const lastKnownStatus = normalizeStatus(payload.lastKnownStatus);

  if (statusesEqual(supplierStatus, lastKnownStatus)) {
    await reschedulePendingHotelPoll(member, { ...payload, lastKnownStatus: supplierStatus }, 0);
    result.outcome = "unchanged";
    return result;
  }

  const stored = await loadStoredBooking(
    dynamo,
    payload.bookingReferenceId,
    payload.hotelKey
  );

  if (!stored) {
    await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
    result.outcome = "db_missing";
    return result;
  }

  const dbStatus = normalizeStatus(stored.bookingStatus);

  if (statusesEqual(dbStatus, supplierStatus)) {
    const nextPayload = { ...payload, lastKnownStatus: supplierStatus, retryCount: 0 };
    if (isHotelSupplierConfirmed(supplierStatus)) {
      await maybeQueueConfirmationEmail({ dynamo, supplierData, stored, payload: nextPayload });
      await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
      result.outcome = "db_already_synced_confirmed";
    } else if (
      isHotelTerminalStopStatus(supplierStatus) ||
      !isHotelPendingPollStatus(supplierStatus)
    ) {
      await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
      result.outcome = "db_already_synced_terminal";
    } else {
      await reschedulePendingHotelPoll(member, nextPayload, 0);
      result.outcome = "db_already_synced_pending";
    }
    return result;
  }

  if (isHotelTerminalStopStatus(supplierStatus)) {
    try {
      await updateBookingStatus({
        dynamo,
        bookingReferenceId: payload.bookingReferenceId,
        hotelKey: payload.hotelKey,
        expectedStatus: dbStatus,
        newStatus: supplierStatus,
        extra: {
          statusPollingStoppedAt: new Date().toISOString(),
          statusPollingStopReason: "SUPPLIER_TERMINAL",
        },
      });
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
    }
    await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
    result.outcome = "terminal";
    return result;
  }

  try {
    await updateBookingStatus({
      dynamo,
      bookingReferenceId: payload.bookingReferenceId,
      hotelKey: payload.hotelKey,
      expectedStatus: dbStatus,
      newStatus: supplierStatus,
    });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      const refreshed = await loadStoredBooking(
        dynamo,
        payload.bookingReferenceId,
        payload.hotelKey
      );
      if (refreshed && statusesEqual(refreshed.bookingStatus, supplierStatus)) {
        if (isHotelSupplierConfirmed(supplierStatus)) {
          await maybeQueueConfirmationEmail({
            dynamo,
            supplierData,
            stored: refreshed,
            payload,
          });
        }
        await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
        result.outcome = "race_resolved";
        return result;
      }
      await reschedulePendingHotelPoll(member, payload, Number(payload.retryCount || 0) + 1);
      result.outcome = "update_race";
      return result;
    }
    throw err;
  }

  const refreshed = await loadStoredBooking(
    dynamo,
    payload.bookingReferenceId,
    payload.hotelKey
  );

  if (isHotelSupplierConfirmed(supplierStatus)) {
    await maybeQueueConfirmationEmail({
      dynamo,
      supplierData,
      stored: refreshed || stored,
      payload: { ...payload, lastKnownStatus: supplierStatus },
    });
    await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
    result.outcome = "confirmed";
    return result;
  }

  if (!isHotelPendingPollStatus(supplierStatus)) {
    await removePendingHotelPoll(payload.bookingReferenceId, payload.hotelKey);
    result.outcome = "non_pending_terminal";
    return result;
  }

  const nextPayload = { ...payload, lastKnownStatus: supplierStatus, retryCount: 0 };
  await updatePendingPollPayload(member, nextPayload);
  await reschedulePendingHotelPoll(member, nextPayload, 0);
  result.outcome = "updated_pending";
  return result;
};

export const reconcilePendingHotelPolls = async (dynamo) => {
  let enqueued = 0;
  for (const status of HOTEL_PENDING_POLL_STATUSES) {
    let lastKey;
    do {
      const page = await dynamo.send(
        new QueryCommand({
          TableName: process.env.HOTEL_BOOK_TABLE,
          IndexName: "bookingStatus-index",
          KeyConditionExpression: "#st = :status",
          ExpressionAttributeNames: { "#st": "bookingStatus" },
          ExpressionAttributeValues: { ":status": { S: status } },
          ExclusiveStartKey: lastKey,
          Limit: 50,
        })
      );
      for (const item of page.Items || []) {
        const row = unmarshall(item);
        if (!row.bookingReferenceId || !row.hotelKey) continue;
        if (row.statusPollingStoppedAt) continue;
        if (row.confirmationEmailQueuedAt && isHotelSupplierConfirmed(row.bookingStatus)) {
          await removePendingHotelPoll(row.bookingReferenceId, row.hotelKey);
          continue;
        }
        const ok = await enqueuePendingHotelPoll({
          bookingReferenceId: row.bookingReferenceId,
          hotelKey: row.hotelKey,
          bookingKey: row.bookingKey,
          searchKey: row.searchKey,
          userId: row.userId,
          userType: row.userType,
          lastKnownStatus: row.bookingStatus,
          enqueuedAt: row.createdAt,
        });
        if (ok) enqueued += 1;
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  }
  return enqueued;
};

export const runHotelPendingPollCycle = async ({ dynamo, requestId }) => {
  const { pollBatchSize, pollMaxDue } = getPollConfig();
  const lockOwner = requestId || `poll-${Date.now()}`;
  const locked = await acquireHotelPollLock(lockOwner);
  if (!locked) {
    return { skipped: true, reason: "overlap_lock" };
  }

  try {
    const { sessionId, conversationId } = await getSessionId();
    if (!sessionId || !conversationId) {
      return { skipped: true, reason: "missing_provesio_session" };
    }

    const dueItems = await fetchDuePendingPolls(pollMaxDue);
    const summary = {
      skipped: false,
      due: dueItems.length,
      processed: 0,
      outcomes: {},
    };

    for (const batch of chunkArray(dueItems, pollBatchSize)) {
      const settled = await Promise.allSettled(
        batch.map((item) =>
          processPendingHotelPollItem({
            dynamo,
            member: item.member,
            payload: item.payload,
            sessionId,
            conversationId,
          })
        )
      );
      for (const entry of settled) {
        summary.processed += 1;
        const outcome =
          entry.status === "fulfilled" ? entry.value?.outcome : "exception";
        summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
        if (entry.status === "rejected") {
          console.error("Poll item failed:", entry.reason);
        }
      }
    }

    return summary;
  } finally {
    await releaseHotelPollLock(lockOwner);
  }
};
