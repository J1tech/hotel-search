import { globalHeaders, InternalError } from "../helper/helper.js";
import { loadCheckoutById, mapNgeniusState, patchCheckoutSnapshot } from "../lib/hotelCheckout.js";

const json = (statusCode, body) => ({
  statusCode,
  ...globalHeaders(),
  body: JSON.stringify(body),
});

const parseBody = (event) =>
  typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};

export const handler = async (event) => {
  try {
    const expected = process.env.HOTEL_CHECKOUT_INTERNAL_SECRET;
    const provided =
      event.headers?.["x-internal-secret"] || event.headers?.["X-Internal-Secret"];
    if (expected && provided !== expected) {
      return json(401, { message: "Unauthorized" });
    }

    const body = parseBody(event);
    const checkoutId = String(body.checkoutId || "").trim();
    const orderReference = String(body.orderReference || "").trim();
    const mapped = mapNgeniusState(body.state || body.paymentStatus);

    if (!checkoutId) return json(400, { message: "checkoutId is required" });

    const rec = await loadCheckoutById(checkoutId);
    if (!rec) return json(404, { message: "Checkout not found" });
    if (rec.orderReference && (!orderReference || rec.orderReference !== orderReference)) {
      return json(409, { message: "orderReference mismatch" });
    }
    if (rec.paymentStatus === "captured") {
      return json(200, { ok: true, checkoutId, paymentStatus: "captured" });
    }

    await patchCheckoutSnapshot(rec.bookingKey, {
      paymentStatus: mapped,
      ...(orderReference ? { orderReference } : {}),
    });
    return json(200, { ok: true, checkoutId, paymentStatus: mapped });
  } catch (error) {
    return InternalError(error);
  }
};
