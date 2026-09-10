import {
  buildSourceLookup,
  collectIdentitiesFromHotels,
  loadHotelModuleSources,
  supplierNetFromHold,
} from "./applyHotelMarkups.js";
import { previewMarkupsPromo } from "./markupsPromoClient.js";
import {
  clearPromoBind,
  getPromoBind,
  setPromoBind,
} from "./hotelPromoBind.js";

export { resolveHotelPromoForCharge } from "./hotelPromoBind.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const tryParseJson = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const publicPromo = (data) => {
  const listedPrice = round2(data.listedPrice);
  const discount = round2(data.discount);
  const payable = round2(data.payable);
  return {
    code: data.promoCode || data.code,
    applyOn: data.applyOn,
    discountType: data.discountType,
    listedPrice,
    originalTotal: listedPrice,
    markupAmount: data.markupAmount,
    discount,
    promoAmount: discount,
    payable,
    chargedAmount: payable,
    flooredToBase: data.flooredToBase,
    matchedScope: data.matchedScope || null,
    matchedIdentity: data.matchedIdentity || null,
  };
};

export const hotelPromoSnapshotFromHold = (preBook) => {
  if (!preBook) return null;
  const listedPrice = round2(Number(preBook.totalNet));
  const supplierNet = round2(Number(supplierNetFromHold(preBook)));
  if (!Number.isFinite(listedPrice) || !Number.isFinite(supplierNet)) return null;
  const markupAmount = round2(listedPrice - supplierNet);
  const currency = String(preBook.currency || "AED").trim().toUpperCase() || "AED";
  return { listedPrice, supplierNet, markupAmount, currency };
};

export const identitiesFromHotelHold = async (preBook) => {
  const rooms = tryParseJson(preBook?.rooms) || [];
  const sources = await loadHotelModuleSources();
  const lookup = buildSourceLookup(sources);
  return collectIdentitiesFromHotels([{ rooms }], lookup);
};

export const previewPromoOnHotelHold = async ({ preBook, promoCode, userId }) => {
  const snap = hotelPromoSnapshotFromHold(preBook);
  if (!snap) {
    return { error: "Pre-book fare is missing", status: 400 };
  }
  const identities = await identitiesFromHotelHold(preBook);
  const preview = await previewMarkupsPromo({
    promoCode,
    module: "hotels",
    listedPrice: snap.listedPrice,
    markupAmount: snap.markupAmount,
    currency: snap.currency,
    userId,
    identities,
  });
  if (!preview.ok) {
    return { error: preview.message, status: preview.status };
  }
  return { promo: publicPromo(preview.data), snap };
};

export const attachBoundPromoToHotelHold = async ({ preBook, userId, bookingKey }) => {
  const bind = await getPromoBind(userId, bookingKey);
  if (!bind?.code) return { promo: null, promoDropped: null };

  const result = await previewPromoOnHotelHold({
    preBook,
    promoCode: bind.code,
    userId,
  });
  if (result.error) {
    await clearPromoBind(userId, bookingKey);
    return {
      promo: null,
      promoDropped: { code: bind.code, reason: result.error },
    };
  }
  await setPromoBind(userId, bookingKey, result.promo);
  return { promo: result.promo, promoDropped: null };
};
