/**
 * Network order/payment states only. ACS 3DS transStatus (Y/N/U/A) is not a
 * capture signal — HPP handles 3DS; we book only on PURCHASED / CAPTURED.
 * Keep in sync with flight-search/lib/ngeniusPaymentState.js and
 * network-genius-payment/src/lib/paymentState.js.
 */
const CAPTURED = new Set(["CAPTURED", "PURCHASED"]);

const FAILED = new Set([
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "CANCELED",
  "REVERSED",
  "VOIDED",
  "REFUNDED",
  "N",
  "U",
  "R",
]);

const EXPIRED = new Set(["EXPIRED"]);

const PENDING = new Set([
  "STARTED",
  "AWAIT_3DS",
  "PENDING",
  "POST_AUTH",
  "AUTHORIZED",
  "AUTHORISED",
  "PARTIALLY_CAPTURED",
  "Y",
  "A",
]);

export const CHECKOUT_PAYMENT_TERMINAL = new Set([
  "captured",
  "failed",
  "expired",
]);

export function normalizeNgeniusStateToken(state) {
  return String(state || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

export function mapNgeniusState(state) {
  const raw = normalizeNgeniusStateToken(state);
  if (!raw) return "pending";
  if (CAPTURED.has(raw)) return "captured";
  if (EXPIRED.has(raw)) return "expired";
  if (PENDING.has(raw)) return "pending";
  if (
    FAILED.has(raw) ||
    raw.includes("DECLIN") ||
    raw.includes("NOT_AUTHENTIC") ||
    /AUTHENTICAT.*FAIL/.test(raw) ||
    /UNABLE.*AUTHENTIC/.test(raw) ||
    raw.endsWith("_FAILED")
  ) {
    return "failed";
  }
  return "pending";
}

function paymentList(order) {
  const src = order?.raw && typeof order.raw === "object" ? order.raw : order || {};
  const list = src?._embedded?.payment;
  return Array.isArray(list) ? list : [];
}

export function ngeniusOrderCaptureState(order) {
  const src = order?.raw && typeof order.raw === "object" ? order.raw : order || {};
  const mapped = paymentList(order).map((p) => mapNgeniusState(p?.state));
  const orderMapped = mapNgeniusState(src.state);
  if (mapped.includes("captured") || orderMapped === "captured") return "captured";
  if (mapped.includes("pending")) return "pending";
  if (mapped.includes("failed") || orderMapped === "failed") return "failed";
  if (mapped.includes("expired") || orderMapped === "expired") return "expired";
  return orderMapped || "pending";
}

export function ngeniusPaidMinorUnits(order) {
  const src = order?.raw && typeof order.raw === "object" ? order.raw : order || {};
  const capturedPay = paymentList(order).find(
    (p) => mapNgeniusState(p?.state) === "captured",
  );
  const value = capturedPay?.amount?.value ?? src.amount?.value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function paymentVerifyError(message, { statusCode, code, paymentStatus }) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.paymentStatus = paymentStatus;
  return err;
}

export function assertCapturedNgeniusOrder(order, { amount, orderReference } = {}) {
  const state = ngeniusOrderCaptureState(order);
  if (state !== "captured") {
    throw paymentVerifyError(
      state === "failed"
        ? "Payment failed. This hotel was not booked."
        : "Payment is not complete yet.",
      {
        statusCode: 402,
        code: state === "failed" ? "PAYMENT_FAILED" : "PAYMENT_NOT_CAPTURED",
        paymentStatus: state,
      },
    );
  }
  const expected = Math.round((Number(amount) || 0) * 100);
  const paid = ngeniusPaidMinorUnits(order);
  if (expected > 0 && paid != null && paid !== expected) {
    throw paymentVerifyError("Paid amount does not match this booking.", {
      statusCode: 409,
      code: "PAYMENT_AMOUNT_MISMATCH",
      paymentStatus: "captured",
    });
  }
  return { state, orderReference: orderReference || order?.reference || null };
}
