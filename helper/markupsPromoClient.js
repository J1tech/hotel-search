import axios from "axios";

const MARKUPS_API_BASE = (
  process.env.MARKUPS_API_BASE ||
  "https://462qjowltd.execute-api.eu-west-1.amazonaws.com/dev"
).replace(/\/+$/, "");

const markupsClient = axios.create({
  timeout: 8000,
  validateStatus: () => true,
});

const parseEnvelope = (response) => {
  const body = response?.data;
  if (body && typeof body === "object") return body;
  return { success: false, message: "Empty response from markups service" };
};

export const previewMarkupsPromo = async (payload) => {
  const response = await markupsClient.post(
    `${MARKUPS_API_BASE}/markups/apply`,
    payload
  );
  const envelope = parseEnvelope(response);
  if (response.status >= 200 && response.status < 300 && envelope.success) {
    return { ok: true, data: envelope.data };
  }
  return {
    ok: false,
    status: response.status >= 400 ? response.status : 400,
    message: envelope.message || "Failed to apply promo code",
  };
};

export const redeemMarkupsPromo = async ({
  code,
  userId,
  bookingId,
  discount,
  payable,
  listedPrice,
}) => {
  const response = await markupsClient.post(
    `${MARKUPS_API_BASE}/promocodes/${encodeURIComponent(code)}/redeem`,
    {
      userId,
      bookingId,
      discount,
      payable,
      listedPrice,
      originalTotal: listedPrice,
      chargedAmount: payable,
    }
  );
  const envelope = parseEnvelope(response);
  if (response.status >= 200 && response.status < 300 && envelope.success) {
    return { ok: true, data: envelope.data };
  }
  if (response.status === 409 && /already redeemed/i.test(envelope.message || "")) {
    return { ok: true, data: envelope.data, alreadyRedeemed: true };
  }
  return {
    ok: false,
    status: response.status >= 400 ? response.status : 400,
    message: envelope.message || "Failed to redeem promo code",
  };
};

export const releaseMarkupsPromo = async ({ code, userId, bookingId }) => {
  const response = await markupsClient.post(
    `${MARKUPS_API_BASE}/promocodes/${encodeURIComponent(code)}/release`,
    { userId, bookingId }
  );
  const envelope = parseEnvelope(response);
  if (response.status >= 200 && response.status < 300 && envelope.success) {
    return { ok: true, data: envelope.data };
  }
  if (response.status === 404 || /not found|not redeemed/i.test(envelope.message || "")) {
    return { ok: true, data: envelope.data, noop: true };
  }
  return {
    ok: false,
    status: response.status >= 400 ? response.status : 400,
    message: envelope.message || "Failed to release promo code",
  };
};
