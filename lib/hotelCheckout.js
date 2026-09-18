import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import redis from "./redisClient.js";
import {
  getPreBookRow,
  isPastExpiry,
  PREBOOK_HOLD_MS,
  preBookExpiresAt,
} from "./hotelPaymentSession.js";
import {
  chargeAmountWithPromo,
  resolveHotelPromoForCharge,
} from "../helper/hotelPromoBind.js";
import {
  assertCapturedNgeniusOrder,
  mapNgeniusState,
  ngeniusOrderCaptureState,
  paymentVerifyError,
} from "./ngeniusPaymentState.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });
const CHECKOUT_INDEX_TTL_SECONDS = 60 * 60 * 24;
const PRODUCT = "hotel";
const checkoutKey = (checkoutId) => `hotelCheckout:${checkoutId}`;
/** Must exceed hotelBooking Lambda timeout so a killed invoke cannot be retried while Provesio may still complete. */
export const CONFIRM_LOCK_MS = 120_000;

const ngeniusBase = () => String(process.env.PAYMENT_API_BASE || "").replace(/\/$/, "");
const preBookTable = () => String(process.env.HOTEL_PRE_BOOK_TABLE || "").trim();

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toMinorUnits = (amount) => Math.round((Number(amount) || 0) * 100);
const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const createCheckoutId = () => uuidv4();

export function httpError(message, { statusCode, code } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  if (code) err.code = code;
  return err;
}

function invoiceExpiryDateUtc(daysAhead = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function paymentLinkFromNgenius(created) {
  return created?.paymentLink || created?.hostedPaymentPageUrl || null;
}

function nowIso() {
  return new Date().toISOString();
}

function tryParseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

async function redisSafeGet(key) {
  try {
    return await redis.get(key);
  } catch (err) {
    console.warn("hotelCheckout redis get failed:", err?.message || err);
    return null;
  }
}

async function redisSafeSet(key, value, ttl) {
  try {
    await redis.set(key, value, "EX", ttl);
  } catch (err) {
    console.warn("hotelCheckout redis set failed:", err?.message || err);
  }
}

function holdExpiresAt(preBook) {
  if (preBook?.checkoutExpiresAt) return preBook.checkoutExpiresAt;
  if (preBook?.createdAt) return preBookExpiresAt(preBook.createdAt);
  return new Date(Date.now() + PREBOOK_HOLD_MS).toISOString();
}

export function holdToCheckoutRecord(preBook) {
  if (!preBook?.bookingKey) return null;
  const snapshot = tryParseJson(preBook.checkoutSnapshot) || {};
  const paymentStatus = String(preBook.paymentStatus || "none");
  const holdStatus = String(preBook.status || "pending");
  const expiresAt = holdExpiresAt(preBook);
  const captured = paymentStatus === "captured" || Boolean(preBook.bookingReferenceId);
  const expired =
    !captured &&
    (holdStatus === "expired" || (expiresAt && isPastExpiry(expiresAt)));
  const mappedPayment = expired && !captured ? "expired" : paymentStatus;
  const amount = numberOrNull(preBook.checkoutAmount) ?? numberOrNull(snapshot.totalPrice) ?? 0;
  return {
    checkoutId: preBook.checkoutId || snapshot.checkoutId || null,
    bookingKey: preBook.bookingKey,
    hotelKey: preBook.hotelKey || snapshot.hotelKey || null,
    searchKey: snapshot.searchKey || tryParseJson(preBook.request)?.searchKey || null,
    userId: preBook.userId || null,
    userType: preBook.userType || null,
    holdStatus: expired && !captured ? "expired" : holdStatus,
    paymentStatus: mappedPayment,
    paymentLink: preBook.paymentLink || "",
    orderReference: preBook.orderReference || "",
    amount,
    currency: String(preBook.checkoutCurrency || snapshot.currency || preBook.currency || "AED").toUpperCase(),
    amountFinal: preBook.amountFinal === true || snapshot.amountFinal === true,
    addonsTotal: numberOrNull(preBook.addonsTotal) ?? numberOrNull(snapshot.addonsTotal) ?? 0,
    bookable: !expired && !preBook.bookingReferenceId && mappedPayment !== "expired",
    bookingReference: preBook.bookingReferenceId || null,
    confirmStatus: preBook.confirmStatus || "none",
    confirmStartedAt: preBook.confirmStartedAt || null,
    expiresAt,
    snapshot,
    createdAt: preBook.createdAt || null,
    updatedAt: preBook.updatedAt || null,
  };
}

export async function writeCheckoutIndex(checkoutId, bookingKey) {
  if (!checkoutId || !bookingKey) return;
  await redisSafeSet(checkoutKey(checkoutId), bookingKey, CHECKOUT_INDEX_TTL_SECONDS);
}

export async function loadCheckoutById(checkoutId) {
  const id = String(checkoutId || "").trim();
  if (!id) return null;
  const bookingKey = await redisSafeGet(checkoutKey(id));
  if (!bookingKey) return null;
  const preBook = await getPreBookRow(bookingKey);
  if (!preBook) return null;
  const rec = holdToCheckoutRecord(preBook);
  if (!rec?.checkoutId || rec.checkoutId !== id) return null;
  return rec;
}

export async function loadCheckoutByBookingKey(bookingKey) {
  const preBook = await getPreBookRow(bookingKey);
  return holdToCheckoutRecord(preBook);
}

async function updatePreBookCheckout(bookingKey, fields) {
  const table = preBookTable();
  if (!table || !bookingKey) return;
  const names = {};
  const values = {};
  const sets = [];
  const add = (attr, value, typeHint) => {
    const nameKey = `#${attr}`;
    const valueKey = `:${attr}`;
    names[nameKey] = attr;
    if (typeHint === "BOOL") values[valueKey] = { BOOL: Boolean(value) };
    else if (typeHint === "N") values[valueKey] = { N: String(value) };
    else values[valueKey] = { S: String(value ?? "") };
    sets.push(`${nameKey} = ${valueKey}`);
  };
  if (fields.checkoutId != null) add("checkoutId", fields.checkoutId);
  if (fields.checkoutSnapshot != null) add("checkoutSnapshot", fields.checkoutSnapshot);
  if (fields.checkoutAmount != null) add("checkoutAmount", String(fields.checkoutAmount));
  if (fields.checkoutCurrency != null) add("checkoutCurrency", fields.checkoutCurrency);
  if (typeof fields.amountFinal === "boolean") add("amountFinal", fields.amountFinal, "BOOL");
  if (fields.addonsTotal != null) add("addonsTotal", String(fields.addonsTotal));
  if (fields.paymentStatus != null) add("paymentStatus", fields.paymentStatus);
  if (fields.paymentLink != null) add("paymentLink", fields.paymentLink);
  if (fields.orderReference != null) add("orderReference", fields.orderReference);
  if (fields.confirmStatus != null) add("confirmStatus", fields.confirmStatus);
  if (fields.confirmStartedAt != null) add("confirmStartedAt", fields.confirmStartedAt);
  if (fields.checkoutExpiresAt != null) add("checkoutExpiresAt", fields.checkoutExpiresAt);
  add("updatedAt", nowIso());
  if (!sets.length) return;
  await dynamo.send(
    new UpdateItemCommand({
      TableName: table,
      Key: { bookingKey: { S: bookingKey } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function patchCheckoutSnapshot(bookingKey, patch = {}) {
  const current = await loadCheckoutByBookingKey(bookingKey);
  if (!current) return null;
  const nextSnapshot =
    patch.snapshot != null && typeof patch.snapshot === "object"
      ? { ...(current.snapshot || {}), ...patch.snapshot }
      : current.snapshot;
  await updatePreBookCheckout(bookingKey, {
    checkoutSnapshot: jsonString(nextSnapshot),
    ...(patch.amount != null ? { checkoutAmount: Number(patch.amount) } : {}),
    ...(patch.currency ? { checkoutCurrency: String(patch.currency).toUpperCase() } : {}),
    ...(typeof patch.amountFinal === "boolean" ? { amountFinal: patch.amountFinal } : {}),
    ...(patch.addonsTotal != null ? { addonsTotal: Number(patch.addonsTotal) || 0 } : {}),
    ...(patch.paymentStatus != null ? { paymentStatus: patch.paymentStatus } : {}),
    ...(patch.paymentLink != null ? { paymentLink: patch.paymentLink } : {}),
    ...(patch.orderReference != null ? { orderReference: patch.orderReference } : {}),
    ...(patch.confirmStatus != null ? { confirmStatus: patch.confirmStatus } : {}),
    ...(patch.confirmStartedAt != null ? { confirmStartedAt: patch.confirmStartedAt } : {}),
  });
  if (current.checkoutId) await writeCheckoutIndex(current.checkoutId, bookingKey);
  return loadCheckoutByBookingKey(bookingKey);
}

export async function persistPaymentLinkExclusive(bookingKey, { paymentLink, orderReference }) {
  const table = preBookTable();
  if (!table || !bookingKey) return false;
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { bookingKey: { S: bookingKey } },
        UpdateExpression:
          "SET paymentLink = :pl, orderReference = :or, paymentStatus = :ps, updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(paymentLink) OR paymentLink = :empty OR paymentStatus = :none OR paymentStatus = :failed",
        ExpressionAttributeValues: {
          ":pl": { S: paymentLink },
          ":or": { S: String(orderReference || "") },
          ":ps": { S: "pending" },
          ":now": { S: nowIso() },
          ":empty": { S: "" },
          ":none": { S: "none" },
          ":failed": { S: "failed" },
        },
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

function snapshotIsComplete(snapshot) {
  const payload = snapshot?.hotelBookingPayload;
  const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
  if (!rooms.length) return false;
  const lead = rooms[0]?.passengers?.[0];
  const email = String(lead?.contact?.contactsProvided?.[0]?.emailAddress?.[0] || "").trim();
  const first = String(lead?.passengerInfo?.givenName || "").trim();
  const last = String(lead?.passengerInfo?.surname || "").trim();
  return Boolean(email && first && last);
}

export async function createHotelCheckout({ userId, userType, body }) {
  const bookingKey = String(body.bookingKey || body.snapshot?.bookingKey || "").trim();
  if (!bookingKey) throw httpError("bookingKey is required", { statusCode: 400 });

  const preBook = await getPreBookRow(bookingKey);
  if (!preBook) throw httpError("Pre-book not found", { statusCode: 404, code: "NOT_FOUND" });
  if (preBook.userId && userId && preBook.userId !== userId) {
    throw httpError("Forbidden: booking does not belong to this user", { statusCode: 403 });
  }
  if (preBook.status === "confirmed" && preBook.bookingReferenceId) {
    throw httpError("Booking already confirmed", { statusCode: 409, code: "ALREADY_BOOKED" });
  }
  const expiresAt = holdExpiresAt(preBook);
  if (preBook.status !== "pending" || isPastExpiry(expiresAt)) {
    throw httpError("Pre-book has expired", { statusCode: 410, code: "EXPIRED" });
  }

  const existing = holdToCheckoutRecord(preBook);
  if (
    existing?.checkoutId &&
    (existing.paymentStatus === "none" || existing.paymentStatus === "pending" || existing.paymentStatus === "failed")
  ) {
    const incoming = body.snapshot && typeof body.snapshot === "object" ? body.snapshot : {};
    const merged = { ...existing.snapshot, ...incoming, checkoutId: existing.checkoutId };
    const promo = await resolveHotelPromoForCharge(userId, bookingKey, preBook.promo);
    const requested = numberOrNull(body.paymentDetails?.amount ?? incoming.totalPrice ?? existing.amount);
    const charge = promo
      ? chargeAmountWithPromo(promo, merged, requested ?? existing.amount)
      : round2(requested ?? existing.amount);
    const currency = String(body.paymentDetails?.currency || incoming.currency || existing.currency || "AED").toUpperCase();
    if (currency !== "AED") {
      throw httpError("Checkout amount must be AED", { statusCode: 400, code: "CURRENCY_NOT_AED" });
    }
    merged.totalPrice = charge;
    merged.currency = currency;
    merged.promo = promo || merged.promo || null;
    merged.amountFinal = snapshotIsComplete(merged);
    await patchCheckoutSnapshot(bookingKey, {
      snapshot: merged,
      amount: charge,
      currency,
      amountFinal: merged.amountFinal,
    });
    await writeCheckoutIndex(existing.checkoutId, bookingKey);
    return loadCheckoutByBookingKey(bookingKey);
  }

  const snapshotIn = body.snapshot && typeof body.snapshot === "object" ? body.snapshot : {};
  const promo = await resolveHotelPromoForCharge(userId, bookingKey, preBook.promo);
  const requested = numberOrNull(body.paymentDetails?.amount ?? snapshotIn.totalPrice ?? preBook.totalNet);
  const charge = promo
    ? chargeAmountWithPromo(promo, snapshotIn, requested ?? Number(preBook.totalNet))
    : round2(requested ?? Number(preBook.totalNet));
  const currency = String(body.paymentDetails?.currency || snapshotIn.currency || preBook.currency || "AED").toUpperCase();
  if (currency !== "AED") {
    throw httpError("Checkout amount must be AED", { statusCode: 400, code: "CURRENCY_NOT_AED" });
  }
  if (!(charge > 0)) {
    throw httpError("Checkout amount is missing", { statusCode: 409, code: "AMOUNT_NOT_FINAL" });
  }

  const checkoutId = createCheckoutId();
  const snapshot = {
    ...snapshotIn,
    checkoutId,
    bookingKey,
    hotelKey: snapshotIn.hotelKey || preBook.hotelKey,
    searchKey: snapshotIn.searchKey || tryParseJson(preBook.request)?.searchKey,
    preBookData: snapshotIn.preBookData || {
      bookingKey: preBook.bookingKey,
      hotelKey: preBook.hotelKey,
      name: preBook.name,
      totalNet: preBook.totalNet,
      currency: preBook.currency,
      checkInDate: preBook.checkInDate,
      checkOutDate: preBook.checkOutDate,
      rooms: tryParseJson(preBook.rooms),
    },
    promo: promo || snapshotIn.promo || null,
    listedTotalNet: promo?.listedPrice ?? snapshotIn.listedTotalNet ?? Number(preBook.totalNet),
    totalPrice: charge,
    currency,
    amountFinal: snapshotIsComplete({ ...snapshotIn, hotelBookingPayload: snapshotIn.hotelBookingPayload }),
    supplierTotalNet: numberOrNull(preBook.supplierTotalNet),
  };

  await updatePreBookCheckout(bookingKey, {
    checkoutId,
    checkoutSnapshot: jsonString(snapshot),
    checkoutAmount: charge,
    checkoutCurrency: currency,
    amountFinal: snapshot.amountFinal,
    addonsTotal: Number(snapshotIn.addonsTotal) || 0,
    paymentStatus: "none",
    paymentLink: "",
    orderReference: "",
    confirmStatus: "none",
    confirmStartedAt: "",
    checkoutExpiresAt: expiresAt,
  });
  await writeCheckoutIndex(checkoutId, bookingKey);
  return loadCheckoutByBookingKey(bookingKey);
}

function leadFromSnapshot(snapshot = {}) {
  const rooms = Array.isArray(snapshot.hotelBookingPayload?.rooms)
    ? snapshot.hotelBookingPayload.rooms
    : [];
  const lead = rooms[0]?.passengers?.[0] || {};
  const info = lead.passengerInfo || {};
  const email = String(lead.contact?.contactsProvided?.[0]?.emailAddress?.[0] || snapshot.email || "").trim();
  const billing = snapshot.billingAddress && typeof snapshot.billingAddress === "object"
    ? snapshot.billingAddress
    : {};
  return {
    email,
    firstName: String(billing.firstName || info.givenName || "").trim(),
    lastName: String(billing.lastName || info.surname || "").trim(),
    address1: String(billing.address1 || billing.street?.[0] || "").trim(),
    city: String(billing.city || billing.cityName || "").trim(),
    countryCode: String(billing.countryCode || "AE").trim().toUpperCase(),
    postalCode: String(billing.postalCode || "").trim(),
  };
}

async function createNgeniusInvoice({
  amount,
  currency,
  emailAddress,
  billingAddress,
  checkoutId,
  bookingKey,
}) {
  const base = ngeniusBase();
  if (!base) throw httpError("PAYMENT_API_BASE is not configured", { statusCode: 503 });
  const currencyCode = String(currency || "AED").toUpperCase();
  const value = toMinorUnits(amount);
  const body = {
    firstName: billingAddress?.firstName,
    lastName: billingAddress?.lastName,
    email: emailAddress,
    transactionType: "PURCHASE",
    emailSubject: "Al Rais hotel payment",
    invoiceExpiryDate: invoiceExpiryDateUtc(1),
    paymentAttempts: 5,
    skipInvoiceCreatedEmailNotification: true,
    items: [
      {
        description: "Al Rais hotel booking",
        totalPrice: { currencyCode, value },
        quantity: 1,
      },
    ],
    total: { currencyCode, value },
    message: "Pay this Al Rais hotel booking. The checkout stays open for 15 minutes.",
    checkoutId,
    offerId: bookingKey,
    product: PRODUCT,
  };
  const res = await axios.post(`${base}/invoices`, body, {
    timeout: 20000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  if (res.status >= 400) {
    const err = new Error(res.data?.message || "Failed to create invoice");
    err.statusCode = res.status;
    err.details = res.data;
    throw err;
  }
  return res.data;
}

async function createNgeniusHostedOrder({
  amount,
  currency,
  emailAddress,
  billingAddress,
  checkoutId,
  bookingKey,
}) {
  const base = ngeniusBase();
  if (!base) throw httpError("PAYMENT_API_BASE is not configured", { statusCode: 503 });
  const body = {
    action: "PURCHASE",
    amount: {
      currencyCode: String(currency || "AED").toUpperCase(),
      value: toMinorUnits(amount),
    },
    emailAddress,
    billingAddress: {
      firstName: billingAddress?.firstName,
      lastName: billingAddress?.lastName,
      ...(billingAddress?.address1 ? { address1: billingAddress.address1 } : {}),
      ...(billingAddress?.city ? { city: billingAddress.city } : {}),
      ...(billingAddress?.countryCode ? { countryCode: billingAddress.countryCode } : {}),
      ...(billingAddress?.postalCode ? { postalCode: billingAddress.postalCode } : {}),
    },
    merchantDefinedData: {
      checkoutId,
      offerId: bookingKey,
      product: PRODUCT,
    },
  };
  const res = await axios.post(`${base}/orders`, body, {
    timeout: 20000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  if (res.status >= 400) {
    const err = new Error(res.data?.message || "Failed to create hosted payment");
    err.statusCode = res.status;
    err.details = res.data;
    throw err;
  }
  return res.data;
}

export async function ensurePaymentLink(record, extras = {}) {
  if (!record?.checkoutId) return record;
  if (record.paymentStatus === "expired" || !record.bookable) return record;
  if (record.paymentStatus === "captured" || record.paymentStatus === "failed") return record;
  if (record.paymentLink && record.orderReference && record.paymentStatus === "pending") {
    return record;
  }
  if (!record.amountFinal) {
    throw httpError("Finalize guest details before generating a payment link", {
      statusCode: 409,
      code: "AMOUNT_NOT_FINAL",
    });
  }
  if (!(Number(record.amount) > 0)) {
    throw httpError("Checkout amount is missing", { statusCode: 409, code: "AMOUNT_NOT_FINAL" });
  }
  const lead = leadFromSnapshot(record.snapshot);
  const emailAddress = extras.emailAddress || lead.email;
  if (!emailAddress) {
    throw httpError("A payer email is required to open payment", {
      statusCode: 409,
      code: "EMAIL_REQUIRED",
    });
  }
  const firstName = extras.billingAddress?.firstName || lead.firstName;
  const lastName = extras.billingAddress?.lastName || lead.lastName;
  if (!firstName || !lastName) {
    throw httpError("Payer name is required to open payment", {
      statusCode: 409,
      code: "NAME_REQUIRED",
    });
  }
  const billingAddress = {
    firstName,
    lastName,
    address1: extras.billingAddress?.address1 || lead.address1,
    city: extras.billingAddress?.city || lead.city,
    countryCode: extras.billingAddress?.countryCode || lead.countryCode,
    postalCode: extras.billingAddress?.postalCode || lead.postalCode,
  };
  const mintArgs = {
    amount: record.amount,
    currency: record.currency,
    emailAddress,
    billingAddress,
    checkoutId: record.checkoutId,
    bookingKey: record.bookingKey,
  };
  let created;
  try {
    created = await createNgeniusInvoice(mintArgs);
  } catch (invoiceErr) {
    console.warn("hotel invoice mint failed, falling back to hosted order:", invoiceErr?.message || invoiceErr);
    created = await createNgeniusHostedOrder(mintArgs);
  }
  const paymentLink = paymentLinkFromNgenius(created);
  const orderReference = created?.orderReference || created?.reference || null;
  if (!paymentLink || !orderReference) {
    throw httpError("Hosted payment page URL was not returned", { statusCode: 502 });
  }
  const persisted = await persistPaymentLinkExclusive(record.bookingKey, {
    paymentLink,
    orderReference,
  });
  if (!persisted) {
    const latest = await loadCheckoutByBookingKey(record.bookingKey);
    if (latest?.paymentLink) return latest;
  }
  await writeCheckoutIndex(record.checkoutId, record.bookingKey);
  return {
    ...record,
    paymentLink,
    orderReference,
    paymentStatus: "pending",
  };
}

export async function fetchNgeniusOrder(orderReference) {
  const base = ngeniusBase();
  if (!base || !orderReference) return null;
  const res = await axios.get(`${base}/orders/${encodeURIComponent(orderReference)}`, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status >= 400) return null;
  return res.data;
}

export async function refreshPaymentStatus(record) {
  let next = record;
  if (
    record?.orderReference &&
    record.paymentStatus !== "captured" &&
    record.paymentStatus !== "expired"
  ) {
    const order = await fetchNgeniusOrder(record.orderReference);
    if (order) {
      const mapped = ngeniusOrderCaptureState(order);
      if (mapped !== record.paymentStatus) {
        next = await patchCheckoutSnapshot(record.bookingKey, { paymentStatus: mapped });
      }
    }
  }
  return reconcileStaleHotelConfirm(next);
}

export function isConfirmLockStale(record) {
  if (!record || record.bookingReference) return false;
  if (String(record.confirmStatus || "") !== "in_progress") return false;
  const started = Date.parse(record.confirmStartedAt || record.updatedAt || "");
  if (!Number.isFinite(started)) return true;
  return Date.now() - started >= CONFIRM_LOCK_MS;
}

export async function reconcileStaleHotelConfirm(record) {
  if (!record?.bookingKey || !isConfirmLockStale(record)) return record;
  return patchCheckoutSnapshot(record.bookingKey, {
    confirmStatus: "confirm_failed",
    confirmStartedAt: "",
  });
}

export async function requireCapturedNgeniusOrder({ orderReference, amount }) {
  if (!orderReference) {
    throw paymentVerifyError("Payment has not been completed.", {
      statusCode: 402,
      code: "PAYMENT_NOT_CAPTURED",
      paymentStatus: "none",
    });
  }
  const order = await fetchNgeniusOrder(orderReference);
  if (!order) {
    throw paymentVerifyError("Could not verify payment with Network.", {
      statusCode: 502,
      code: "PAYMENT_VERIFY_FAILED",
      paymentStatus: "pending",
    });
  }
  assertCapturedNgeniusOrder(order, { amount, orderReference });
  return order;
}

export async function stampConfirmInProgress(checkoutId) {
  let current = await loadCheckoutById(checkoutId);
  if (!current) throw httpError("Checkout not found", { statusCode: 404, code: "NOT_FOUND" });
  if (current.bookingReference) {
    throw httpError("Booking already confirmed", { statusCode: 409, code: "ALREADY_BOOKED" });
  }
  current = await reconcileStaleHotelConfirm(current);
  if (current.confirmStatus === "in_progress") {
    throw httpError("Booking confirmation already in progress", {
      statusCode: 409,
      code: "CONFIRM_IN_PROGRESS",
    });
  }
  const table = preBookTable();
  const startedAt = nowIso();
  if (table && current.bookingKey) {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: table,
          Key: { bookingKey: { S: current.bookingKey } },
          UpdateExpression:
            "SET confirmStatus = :ip, confirmStartedAt = :now, updatedAt = :now",
          ConditionExpression:
            "(attribute_not_exists(bookingReferenceId) OR bookingReferenceId = :empty) AND (attribute_not_exists(confirmStatus) OR confirmStatus <> :ip)",
          ExpressionAttributeValues: {
            ":ip": { S: "in_progress" },
            ":now": { S: startedAt },
            ":empty": { S: "" },
          },
        }),
      );
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        const latest = await loadCheckoutByBookingKey(current.bookingKey);
        if (latest?.bookingReference) {
          throw httpError("Booking already confirmed", { statusCode: 409, code: "ALREADY_BOOKED" });
        }
        throw httpError("Booking confirmation already in progress", {
          statusCode: 409,
          code: "CONFIRM_IN_PROGRESS",
        });
      }
      throw err;
    }
    if (current.checkoutId) await writeCheckoutIndex(current.checkoutId, current.bookingKey);
    return { ...current, confirmStatus: "in_progress", confirmStartedAt: startedAt };
  }
  await patchCheckoutSnapshot(current.bookingKey, {
    confirmStatus: "in_progress",
    confirmStartedAt: startedAt,
  });
  return current;
}

export function assertCheckoutOwner(record, userId) {
  const owner = String(record?.userId || "").trim();
  if (!owner) return true;
  if (!userId) return false;
  return owner === String(userId);
}

export function toPublicCheckout(record) {
  if (!record) return null;
  return {
    checkoutId: record.checkoutId,
    bookingKey: record.bookingKey,
    hotelKey: record.hotelKey,
    searchKey: record.searchKey,
    holdStatus: record.holdStatus,
    paymentStatus: record.paymentStatus,
    paymentLink: record.paymentLink,
    orderReference: record.orderReference,
    amount: record.amount,
    currency: record.currency,
    amountFinal: record.amountFinal,
    addonsTotal: record.addonsTotal,
    bookable: record.bookable,
    bookingReference: record.bookingReference,
    confirmStatus: record.confirmStatus,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt || null,
    snapshot: record.snapshot,
  };
}

export function toPaymentStatus(record) {
  return {
    checkoutId: record.checkoutId,
    bookingKey: record.bookingKey,
    paymentStatus: record.paymentStatus,
    bookable: record.bookable,
    bookingReference: record.bookingReference,
    orderReference: record.orderReference,
    paymentLink: record.paymentLink,
    confirmStatus: record.confirmStatus,
  };
}

export { mapNgeniusState, ngeniusOrderCaptureState };
