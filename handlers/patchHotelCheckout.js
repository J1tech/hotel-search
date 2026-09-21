import { verifyToken } from "./authorizerLayer.js";
import { globalHeaders, InternalError } from "../helper/helper.js";
import {
  assertCheckoutOwner,
  loadCheckoutById,
  patchCheckoutSnapshot,
  retireCurrentPaymentLink,
  toPublicCheckout,
} from "../lib/hotelCheckout.js";

const json = (statusCode, body) => ({
  statusCode,
  ...globalHeaders(),
  body: JSON.stringify(body),
});

const parseBody = (event) =>
  typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};

export const handler = async (event) => {
  try {
    const authVerification = await verifyToken(event);
    if (authVerification?.principalId === "unknown") {
      return json(401, { message: "Unauthorized: Invalid or expired token" });
    }

    const checkoutId = event.pathParameters?.checkoutId;
    if (!checkoutId) return json(400, { message: "Missing checkoutId" });

    const record = await loadCheckoutById(checkoutId);
    if (!record?.checkoutId) return json(404, { message: "Checkout not found" });

    const body = parseBody(event) || {};
    const isOwner = assertCheckoutOwner(record, authVerification?.context?.sub);
    const refreshPaymentLink =
      body.refreshPaymentLink === true && record.paymentStatus !== "captured";
    if (!isOwner && !refreshPaymentLink) {
      return json(403, { message: "Forbidden" });
    }

    if (refreshPaymentLink) {
      const updated = await retireCurrentPaymentLink(record, "pay_click");
      return json(200, toPublicCheckout(updated));
    }

    if (!isOwner) {
      return json(403, { message: "Forbidden" });
    }

    if (record.paymentStatus === "captured") {
      return json(200, toPublicCheckout(record));
    }

    const nextSnapshot = {
      ...(record.snapshot || {}),
      ...(body.snapshot && typeof body.snapshot === "object" ? body.snapshot : {}),
    };
    if (body.hotelBookingPayload) nextSnapshot.hotelBookingPayload = body.hotelBookingPayload;
    if (body.preBookData) nextSnapshot.preBookData = body.preBookData;
    if (body.hotelDetail !== undefined) nextSnapshot.hotelDetail = body.hotelDetail;
    if (body.promo !== undefined) nextSnapshot.promo = body.promo;
    if (body.specialRequest !== undefined) nextSnapshot.specialRequest = body.specialRequest;
    if (body.billingAddress !== undefined) nextSnapshot.billingAddress = body.billingAddress;
    if (body.cancellationPolicies !== undefined) {
      nextSnapshot.cancellationPolicies = body.cancellationPolicies;
    }
    if (body.selectedRooms !== undefined) nextSnapshot.selectedRooms = body.selectedRooms;

    const amount = body.amount ?? body.paymentDetails?.amount ?? nextSnapshot.totalPrice;
    const currency = String(
      body.currency ?? body.paymentDetails?.currency ?? nextSnapshot.currency ?? record.currency ?? "AED",
    ).toUpperCase();
    if (currency && currency !== "AED") {
      return json(400, { message: "Checkout amount must be AED", code: "CURRENCY_NOT_AED" });
    }
    const amountFinal =
      typeof body.amountFinal === "boolean" ? body.amountFinal : record.amountFinal;
    nextSnapshot.amountFinal = amountFinal;
    if (amount != null) {
      nextSnapshot.totalPrice = Number(amount);
    }
    nextSnapshot.currency = currency;

    const amountChanged =
      amount != null &&
      Number(record.amount) > 0 &&
      Math.abs(Number(amount) - Number(record.amount)) >= 0.01;

    const updated = await patchCheckoutSnapshot(record.bookingKey, {
      snapshot: nextSnapshot,
      amount,
      currency,
      amountFinal,
      ...((refreshPaymentLink || (amountChanged && record.paymentStatus !== "captured"))
        ? { paymentLink: "", orderReference: "", paymentStatus: "none" }
        : {}),
    });
    return json(200, toPublicCheckout(updated));
  } catch (error) {
    if (error?.statusCode) {
      return json(error.statusCode, { message: error.message, code: error.code });
    }
    return InternalError(error);
  }
};
