import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import redis from "./redisClient.js";
import { fetchNgeniusOrder } from "./hotelCheckout.js";
import { summarizeNgeniusPayment } from "./ngeniusPaymentState.js";

const sqs = new SQSClient({ region: process.env.REGION || "eu-west-1" });
const stage = () => String(process.env.STAGE || "dev");

const SECRET_KEYS = /^(pan|cvv|cvc|password|secret|token|authorization)$/i;

function safeJson(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === "string") {
    try {
      return safeJson(JSON.parse(value), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => safeJson(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = safeJson(v, depth + 1);
  }
  return out;
}

function formatDetailsText(details) {
  return JSON.stringify(safeJson(details), null, 2);
}

function formatPhoneParts(areaCode, phoneNumber) {
  const area = String(areaCode || "").replace(/\D/g, "");
  const num = String(phoneNumber || "").replace(/\D/g, "");
  if (!num || num.length < 7) return null;
  if (area) return `+${area}${num}`;
  return `+${num}`;
}

function contactFromSnapshot(snapshot) {
  const snap = safeJson(snapshot) || {};
  const rooms = Array.isArray(snap.hotelBookingPayload?.rooms) ? snap.hotelBookingPayload.rooms : [];
  const lead = rooms[0]?.passengers?.[0];
  const phoneRow = lead?.contact?.contactsProvided?.[0]?.phone?.[0];
  const email =
    lead?.contact?.contactsProvided?.[0]?.emailAddress?.[0] ||
    snap.email ||
    null;
  const phone =
    (phoneRow ? formatPhoneParts(phoneRow.areaCode, phoneRow.phoneNumber) : null) ||
    snap.phone ||
    null;
  const given = lead?.passengerInfo?.givenName || null;
  const surname = lead?.passengerInfo?.surname || null;
  return { email, phone, leadName: [given, surname].filter(Boolean).join(" ") || null };
}

async function idempotencyOk(product, scenario, id) {
  const key = `opsAlert:${stage()}:${product}:${scenario}:${String(id || "unknown")}`;
  try {
    const result = await redis.set(key, "1", "EX", 86400, "NX");
    return result === "OK";
  } catch (err) {
    console.warn("ops alert idempotency skipped:", err?.message || err);
    return true;
  }
}

async function ngeniusBlock(orderReference) {
  if (!orderReference) return null;
  try {
    const order = await fetchNgeniusOrder(orderReference);
    return order ? summarizeNgeniusPayment(order) : { fetchError: "order_not_found" };
  } catch (err) {
    return { fetchError: err?.message || String(err) };
  }
}

export async function sendHotelOpsAlert({
  scenario,
  record,
  bookingRecord,
  supplierStatus,
  reason,
  error,
  extra = {},
}) {
  const checkoutId = record?.checkoutId || bookingRecord?.checkoutId || null;
  const dedupeId = checkoutId || bookingRecord?.bookingReferenceId || record?.bookingKey;
  if (!(await idempotencyOk("hotel", scenario, dedupeId))) {
    return false;
  }
  const queueUrl = process.env.SEND_EMAIL_QUEUE;
  if (!queueUrl) {
    console.warn("SEND_EMAIL_QUEUE not set, skipping hotel ops alert");
    return false;
  }

  const snapshot = record?.snapshot || bookingRecord?.checkoutSnapshot || null;
  const contact = contactFromSnapshot(snapshot);
  const orderReference = record?.orderReference || bookingRecord?.orderReference || null;
  const ngeniusPayment = await ngeniusBlock(orderReference);

  const details = {
    generatedAt: new Date().toISOString(),
    stage: stage(),
    product: "hotel",
    scenario,
    reason: reason || null,
    checkoutId,
    bookingKey: record?.bookingKey || bookingRecord?.bookingKey || null,
    hotelKey: record?.hotelKey || bookingRecord?.hotelKey || null,
    searchKey: record?.searchKey || bookingRecord?.searchKey || null,
    userId: record?.userId || bookingRecord?.userId || null,
    userType: record?.userType || bookingRecord?.userType || null,
    holdStatus: record?.holdStatus || null,
    paymentStatus: record?.paymentStatus || bookingRecord?.paymentStatus || null,
    confirmStatus: record?.confirmStatus || null,
    bookingReferenceId: record?.bookingReference || bookingRecord?.bookingReferenceId || null,
    supplierBookingStatus: supplierStatus || bookingRecord?.bookingStatus || null,
    orderReference,
    amounts: {
      amount: record?.amount ?? null,
      currency: record?.currency ?? null,
      amountFinal: record?.amountFinal ?? null,
      addonsTotal: record?.addonsTotal ?? null,
      chargedAmount: bookingRecord?.chargedAmount ?? null,
      chargedCurrency: bookingRecord?.chargedCurrency ?? null,
    },
    contact,
    ngeniusPayment,
    snapshot,
    bookingRecord: bookingRecord ? safeJson(bookingRecord) : null,
    error: error
      ? {
          message: error?.message || String(error),
          code: error?.code || null,
          statusCode: error?.statusCode || error?.response?.status || null,
          details: safeJson(error?.response?.data || error?.details || null),
        }
      : null,
    extra: safeJson(extra),
  };

  const attachmentText = formatDetailsText(details);
  const bookingReferenceId = details.bookingReferenceId;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        opsBookingAlert: true,
        product: "hotel",
        scenario,
        checkoutId,
        bookingReferenceId,
        attachmentText,
        attachmentFilename: `hotel-${scenario}-${checkoutId || bookingReferenceId || "alert"}.txt`,
      }),
    }),
  );
  return true;
}
