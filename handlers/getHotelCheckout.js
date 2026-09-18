import { verifyToken } from "./authorizerLayer.js";
import { globalHeaders, InternalError } from "../helper/helper.js";
import {
  ensurePaymentLink,
  loadCheckoutById,
  refreshPaymentStatus,
  toPublicCheckout,
} from "../lib/hotelCheckout.js";

const json = (statusCode, body) => ({
  statusCode,
  ...globalHeaders(),
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  try {
    const authVerification = await verifyToken(event);
    if (authVerification?.principalId === "unknown") {
      return json(401, { message: "Unauthorized: Invalid or expired token" });
    }

    const checkoutId = event.pathParameters?.checkoutId;
    if (!checkoutId) return json(400, { message: "Missing checkoutId" });

    let record = await loadCheckoutById(checkoutId);
    if (!record?.checkoutId) {
      return json(404, { message: "Checkout not found", code: "NOT_FOUND" });
    }

    try {
      record = await refreshPaymentStatus(record);
    } catch (err) {
      console.warn("hotel checkout payment refresh failed:", err?.message || err);
    }

    if (record.paymentStatus === "expired" || record.holdStatus === "expired") {
      return json(410, {
        ...toPublicCheckout(record),
        message: "Checkout expired",
        code: "EXPIRED",
      });
    }

    const rooms = Array.isArray(record.snapshot?.hotelBookingPayload?.rooms)
      ? record.snapshot.hotelBookingPayload.rooms
      : [];
    const lead = rooms[0]?.passengers?.[0];
    const email =
      lead?.contact?.contactsProvided?.[0]?.emailAddress?.[0] ||
      record.snapshot?.email ||
      null;
    const given = String(lead?.passengerInfo?.givenName || "");
    const surname = String(lead?.passengerInfo?.surname || "");

    let next = record;
    try {
      next = await ensurePaymentLink(record, {
        emailAddress: email,
        billingAddress: { firstName: given, lastName: surname },
      });
    } catch (err) {
      if (err?.code === "AMOUNT_NOT_FINAL" || err?.statusCode === 409) {
        return json(409, {
          ...toPublicCheckout(record),
          message: err.message,
          code: err.code || "AMOUNT_NOT_FINAL",
        });
      }
      throw err;
    }

    return json(200, toPublicCheckout(next));
  } catch (error) {
    if (error?.statusCode) {
      return json(error.statusCode, { message: error.message, code: error.code });
    }
    return InternalError(error);
  }
};
