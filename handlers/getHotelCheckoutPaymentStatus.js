import { verifyToken } from "./authorizerLayer.js";
import { globalHeaders, InternalError } from "../helper/helper.js";
import {
  loadCheckoutById,
  refreshPaymentStatus,
  toPaymentStatus,
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
    if (!record?.checkoutId) return json(404, { message: "Checkout not found" });

    try {
      record = await refreshPaymentStatus(record);
    } catch (err) {
      console.warn("hotel payment status refresh failed:", err?.message || err);
    }

    return json(200, toPaymentStatus(record));
  } catch (error) {
    return InternalError(error);
  }
};
