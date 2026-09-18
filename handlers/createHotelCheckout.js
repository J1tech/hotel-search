import { verifyToken } from "./authorizerLayer.js";
import { globalHeaders, InternalError } from "../helper/helper.js";
import { createHotelCheckout, toPublicCheckout } from "../lib/hotelCheckout.js";

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
    const body = parseBody(event);
    const record = await createHotelCheckout({
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      body,
    });
    return json(200, toPublicCheckout(record));
  } catch (error) {
    if (error?.statusCode) {
      return json(error.statusCode, { message: error.message, code: error.code });
    }
    return InternalError(error);
  }
};
