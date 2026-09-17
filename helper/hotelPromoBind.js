/** Match the 15-minute hotel pre-book hold. */
const PROMO_BIND_TTL_SEC = 15 * 60;
const REDIS_CMD_MS = 800;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const getRedis = async () => {
  const { default: redis } = await import("../lib/redisClient.js");
  return redis;
};

const withTimeout = (promise, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), REDIS_CMD_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const promoBindKey = (userId, bookingKey) =>
  `hotelPromo:${userId}:${bookingKey}`;

export const getPromoBind = async (userId, bookingKey) => {
  if (!userId || !bookingKey) return null;
  try {
    const redis = await getRedis();
    const raw = await withTimeout(redis.get(promoBindKey(userId, bookingKey)), "getPromoBind");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.code ? parsed : null;
  } catch (error) {
    console.error("getPromoBind failed:", error?.message || error);
    return null;
  }
};

export const setPromoBind = async (userId, bookingKey, promo) => {
  if (!userId || !bookingKey || !promo?.code) return;
  const redis = await getRedis();
  await withTimeout(
    redis.set(promoBindKey(userId, bookingKey), JSON.stringify(promo), "EX", PROMO_BIND_TTL_SEC),
    "setPromoBind"
  );
};

export const clearPromoBind = async (userId, bookingKey) => {
  if (!userId || !bookingKey) return;
  try {
    const redis = await getRedis();
    await withTimeout(redis.del(promoBindKey(userId, bookingKey)), "clearPromoBind");
  } catch (error) {
    console.error("clearPromoBind failed:", error?.message || error);
  }
};

export const stringifyPromo = (promo) =>
  promo?.code ? JSON.stringify(promo) : "";

const promoFromObject = (parsed) => {
  if (!parsed || typeof parsed !== "object") return null;
  const code = String(parsed.code ?? parsed.promoCode ?? "").trim().toUpperCase();
  if (!code) return null;
  return parsed.code ? parsed : { ...parsed, code };
};

export const parseStoredPromo = (raw) => {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw) && (raw.code || raw.promoCode) && raw.S == null) {
    return promoFromObject(raw);
  }
  const value = typeof raw === "object" ? raw.S ?? "" : raw;
  if (typeof value !== "string" || !value) return null;
  try {
    return promoFromObject(JSON.parse(value));
  } catch {
    return null;
  }
};

const amountsClose = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.02;

export const snapshotPromoForBooking = (promo) => {
  const parsed = parseStoredPromo(promo);
  if (!parsed?.code) return null;
  let listedPrice = round2(Number(parsed.listedPrice ?? parsed.originalTotal));
  const discount = round2(Number(parsed.discount ?? parsed.promoAmount));
  let payable = round2(Number(parsed.payable ?? parsed.chargedAmount));
  if (Number.isFinite(listedPrice) && Number.isFinite(payable) && amountsClose(listedPrice, payable) && discount > 0) {
    payable = round2(Math.max(0, listedPrice - discount));
  } else if (!Number.isFinite(listedPrice) && Number.isFinite(payable) && Number.isFinite(discount) && discount > 0) {
    listedPrice = round2(payable + discount);
  } else if (!Number.isFinite(payable) && Number.isFinite(listedPrice) && Number.isFinite(discount) && discount > 0) {
    payable = round2(Math.max(0, listedPrice - discount));
  }
  if (!Number.isFinite(listedPrice) || !Number.isFinite(discount) || !Number.isFinite(payable)) {
    return parsed;
  }
  if (!(discount > 0) || payable < 0) return parsed;
  return {
    ...parsed,
    listedPrice,
    originalTotal: listedPrice,
    discount,
    promoAmount: discount,
    payable,
    chargedAmount: payable,
  };
};

/** Redis bind first (fail-fast). Dynamo `promo` column is the fallback. */
export const resolveHotelPromoForCharge = async (userId, bookingKey, storedPromo) => {
  const bound = await getPromoBind(userId, bookingKey);
  return snapshotPromoForBooking(bound) || snapshotPromoForBooking(storedPromo) || parseStoredPromo(storedPromo);
};

export const chargeAmountWithPromo = (promo, snapshot, requestedAmount) => {
  const payable = Number(promo?.payable);
  if (!Number.isFinite(payable)) return requestedAmount;
  const extras = Number(snapshot?.extrasTotal ?? snapshot?.addonsTotal);
  if (Number.isFinite(extras) && extras >= 0) return round2(payable + extras);
  const total = Number(requestedAmount);
  const listed = Number(promo.listedPrice);
  if (Number.isFinite(total) && Number.isFinite(listed) && total + 0.005 >= listed) {
    return round2(payable + (total - listed));
  }
  return Number.isFinite(total) ? round2(total) : round2(payable);
};

export const foldPromoOntoHotelTotal = (hotel, promo) => {
  const snap = snapshotPromoForBooking(promo);
  if (!hotel || typeof hotel !== "object" || !snap?.discount) return hotel;
  const current = Number(hotel.totalNet);
  const payable = Number(snap.payable);
  const listed = Number(snap.listedPrice);
  if (!Number.isFinite(payable)) return hotel;
  if (amountsClose(current, payable)) return hotel;
  if (amountsClose(current, listed) || (Number.isFinite(current) && Number.isFinite(listed) && current + 0.005 >= listed)) {
    hotel.totalNet = payable;
  }
  return hotel;
};
