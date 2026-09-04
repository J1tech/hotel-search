import axios from "axios";
import {
  BatchGetItemCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import redis from "../lib/redisClient.js";
import { deepClone } from "./objectUtils.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION || "eu-west-1" });

const MARKUPS_TABLE = process.env.MARKUPS_TABLE || "markups-dev";
const MARKUPS_API_BASE = (
  process.env.MARKUPS_API_BASE ||
  "https://462qjowltd.execute-api.eu-west-1.amazonaws.com/dev"
).replace(/\/+$/, "");
const MODULE_CONFIG_CACHE_KEY = "module-config:hotels:sources";
const MODULE_CONFIG_TTL_SEC = 60;
const RULE_MEM_TTL_MS = 30_000;
const BATCH_GET_LIMIT = 100;
const HOTEL_MODULE = "hotels";

const SUPPLIER_ALIASES = {
  hotelbeds: "BEDS_ONLINE",
  hotelbedsrest: "BEDS_ONLINE",
  beds_online: "BEDS_ONLINE",
  expedia: "EXPEDIA",
  tbo: "TBO_HOTELS",
};

const KEYS = {
  global: () => ({ pk: "GLOBAL", sk: "CONFIG" }),
  module: () => ({ pk: `MODULE#${HOTEL_MODULE}`, sk: "CONFIG" }),
  supplier: (supplierId) => ({
    pk: `MODULE#${HOTEL_MODULE}`,
    sk: `SUPPLIER#${supplierId}`,
  }),
};

const ruleItemMem = new Map();
const sourceMem = { exp: 0, sources: null };
let dynamoReadDisabled = false;

const keyId = (key) => `${key.pk}|${key.sk}`;

const compact = (raw) =>
  String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const slugSourceKey = (raw) => {
  const slug = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || null;
};

export const buildSourceLookup = (sources = []) => {
  const byName = new Map();
  const byKey = new Map();
  const byCompact = new Map();
  for (const source of sources) {
    const sourceKey = String(source?.sourceKey || "").trim();
    if (!sourceKey) continue;
    const name = String(source?.name || "").trim();
    byKey.set(sourceKey.toLowerCase(), sourceKey);
    if (name) {
      byName.set(name.toLowerCase(), sourceKey);
      byCompact.set(compact(name), sourceKey);
    }
    byCompact.set(compact(sourceKey), sourceKey);
  }
  return { byName, byKey, byCompact };
};

export const resolveSupplierId = (raw, lookup) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lookup?.byName?.has(lower)) return lookup.byName.get(lower);
  if (lookup?.byKey?.has(lower)) return lookup.byKey.get(lower);
  const squeezed = compact(text);
  if (lookup?.byCompact?.has(squeezed)) return lookup.byCompact.get(squeezed);
  if (SUPPLIER_ALIASES[lower]) return SUPPLIER_ALIASES[lower];
  if (SUPPLIER_ALIASES[squeezed]) return SUPPLIER_ALIASES[squeezed];
  return slugSourceKey(text);
};

export const resolveCapForCurrency = (maxCap, currency) => {
  if (!maxCap || typeof maxCap !== "object" || !currency) return undefined;
  const code = String(currency).trim().toUpperCase();
  if (maxCap[code] === undefined || maxCap[code] === null) return undefined;
  return Number(maxCap[code]);
};

/** Same math as al-rais-markups / applyFlightMarkups. */
export const calculateMarkup = (basePrice, percent, maxCap, currency) => {
  const base = Number(basePrice);
  const pct = Number(percent);
  if (!Number.isFinite(base) || base < 0) {
    return { basePrice: base, percent: pct, markupAmount: 0, finalPrice: base, currency };
  }
  const rawMarkup = (base * pct) / 100;
  const cap = resolveCapForCurrency(maxCap, currency);
  const markupAmount =
    cap !== undefined && Number.isFinite(cap) ? Math.min(rawMarkup, cap) : rawMarkup;
  return {
    basePrice: base,
    percent: pct,
    markupAmount,
    finalPrice: base + markupAmount,
    currency: String(currency || "AED").trim().toUpperCase(),
  };
};

const hasPercent = (item) => item && item.percent !== undefined && item.percent !== null;

const toRuleItem = (item) => {
  if (!item) return null;
  return {
    pk: item.pk,
    sk: item.sk,
    percent: hasPercent(item) ? Number(item.percent) : null,
    maxCap:
      item.maxCap && typeof item.maxCap === "object" && !Array.isArray(item.maxCap)
        ? item.maxCap
        : undefined,
  };
};

export const markupKeysForIdentity = ({ supplierId }) => {
  const keys = [];
  if (supplierId) keys.push({ ...KEYS.supplier(supplierId), level: "supplier" });
  keys.push({ ...KEYS.module(), level: "module" });
  keys.push({ ...KEYS.global(), level: "global" });
  return keys;
};

const uniqueKeys = (keys) => {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const id = keyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ pk: key.pk, sk: key.sk });
  }
  return out;
};

const memGet = (key) => {
  const hit = ruleItemMem.get(keyId(key));
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    ruleItemMem.delete(keyId(key));
    return undefined;
  }
  return hit.item;
};

const memSet = (item) => {
  if (!item?.pk || !item?.sk) return;
  ruleItemMem.set(`${item.pk}|${item.sk}`, {
    exp: Date.now() + RULE_MEM_TTL_MS,
    item,
  });
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function batchGetMarkupItems(keys) {
  if (!keys.length) return [];
  const items = [];
  for (const group of chunk(keys, BATCH_GET_LIMIT)) {
    let requestItems = {
      [MARKUPS_TABLE]: { Keys: group.map((key) => marshall(key)) },
    };
    let attempts = 0;
    while (requestItems && Object.keys(requestItems).length && attempts < 4) {
      attempts += 1;
      const result = await dynamo.send(
        new BatchGetItemCommand({ RequestItems: requestItems }),
      );
      for (const raw of result.Responses?.[MARKUPS_TABLE] || []) {
        items.push(unmarshall(raw));
      }
      const unprocessed = result.UnprocessedKeys || {};
      requestItems =
        unprocessed[MARKUPS_TABLE]?.Keys?.length ? unprocessed : null;
      if (requestItems) {
        await new Promise((r) => setTimeout(r, 25 * attempts));
      }
    }
  }
  return items;
}

const putPublicRule = (map, key, rule) => {
  if (!rule || !hasPercent(rule)) return;
  map.set(keyId(key), toRuleItem({ ...key, ...rule }));
};

function rulesFromBasePayload(data, map) {
  if (data?.global) putPublicRule(map, KEYS.global(), data.global);
  const hotels = (data?.modules || []).find(
    (row) => String(row?.module || "").toLowerCase() === HOTEL_MODULE,
  );
  if (hotels) putPublicRule(map, KEYS.module(), hotels);
  for (const row of data?.suppliers?.hotels || []) {
    const supplierId = resolveSupplierId(row?.supplierId);
    if (supplierId) putPublicRule(map, KEYS.supplier(supplierId), row);
  }
}

async function loadRulesViaHttp(identities) {
  const map = new Map();
  try {
    const baseRes = await axios.get(`${MARKUPS_API_BASE}/markups`, {
      params: { level: "base" },
      timeout: 4000,
    });
    if (baseRes?.data?.success) rulesFromBasePayload(baseRes.data.data, map);
  } catch (error) {
    console.error("[HOTEL MARKUP] HTTP base rules failed:", error?.message || error);
  }
  return map;
}

export const pickHotelRule = (identity, ruleMap) => {
  for (const key of markupKeysForIdentity(identity)) {
    const rule = ruleMap.get(keyId(key));
    if (rule && hasPercent(rule)) {
      return { rule, appliedLevel: key.level };
    }
  }
  return { rule: { percent: 10 }, appliedLevel: "default" };
};

async function loadRuleMap(identities) {
  const needed = uniqueKeys([
    KEYS.global(),
    KEYS.module(),
    ...identities.flatMap((identity) => markupKeysForIdentity(identity)),
  ]);

  const map = new Map();
  const missing = [];
  for (const key of needed) {
    const cached = memGet(key);
    if (cached !== undefined) {
      if (cached && hasPercent(cached)) map.set(keyId(key), cached);
      continue;
    }
    missing.push(key);
  }

  if (!missing.length) return map;

  if (dynamoReadDisabled) return loadRulesViaHttp(identities);

  try {
    const items = await batchGetMarkupItems(missing);
    const found = new Set();
    for (const item of items) {
      const rule = toRuleItem(item);
      memSet(rule);
      found.add(`${item.pk}|${item.sk}`);
      if (hasPercent(rule)) map.set(`${item.pk}|${item.sk}`, rule);
    }
    for (const key of missing) {
      if (!found.has(keyId(key))) memSet({ pk: key.pk, sk: key.sk, percent: null });
    }
  } catch (error) {
    console.error("[HOTEL MARKUP] Dynamo batch get failed:", error?.message || error);
    dynamoReadDisabled = true;
    return loadRulesViaHttp(identities);
  }

  return map;
}

export const identityFromRoom = (room, lookup) => ({
  supplierId: resolveSupplierId(room?.financialInfo?.supplier, lookup),
});

const collectIdentitiesFromHotels = (hotels, lookup) => {
  const identities = [];
  const seen = new Set();
  for (const hotel of hotels || []) {
    for (const room of hotel?.rooms || []) {
      const identity = identityFromRoom(room, lookup);
      const id = identity.supplierId || "__default__";
      if (seen.has(id)) continue;
      seen.add(id);
      identities.push(identity);
    }
  }
  if (!identities.length) identities.push({ supplierId: null });
  return identities;
};

const markRoomRate = (roomRate, rule, currency) => {
  if (!roomRate || roomRate.netAmount == null) return;
  const priced = calculateMarkup(roomRate.netAmount, rule.percent, rule.maxCap, currency);
  roomRate.netAmount = priced.finalPrice;
};

const recomputeHotelTotalPrice = (hotel) => {
  const rooms = Array.isArray(hotel?.rooms) ? hotel.rooms : [];
  const available = rooms.filter(
    (room) => room?.ratePlan?.availableStatus === "Available" || !room?.ratePlan?.availableStatus,
  );
  const pool = available.length ? available : rooms;
  let minPrice = null;
  for (const room of pool) {
    const amount = Number(room?.roomRate?.netAmount);
    if (!Number.isFinite(amount)) continue;
    minPrice = minPrice == null ? amount : Math.min(minPrice, amount);
  }
  if (minPrice != null) hotel.totalPrice = minPrice;
};

export const applyHotelMarkupsToRooms = (rooms, { lookup, ruleMap }) => {
  for (const room of rooms || []) {
    const { rule } = pickHotelRule(identityFromRoom(room, lookup), ruleMap);
    const currency = room?.roomRate?.currency || "AED";
    markRoomRate(room?.roomRate, rule, currency);
  }
};

export const applyHotelMarkupsToHotel = async (hotel, { sources, ruleMap: existingMap } = {}) => {
  if (!hotel || typeof hotel !== "object") return hotel;
  const lookup = buildSourceLookup(sources || []);
  const ruleMap =
    existingMap ||
    (await loadRuleMap(collectIdentitiesFromHotels([hotel], lookup)));
  applyHotelMarkupsToRooms(hotel.rooms, { lookup, ruleMap });
  if (hotel.totalNet != null) {
    const currency = hotel.currency || hotel.rooms?.[0]?.roomRate?.currency || "AED";
    const primarySupplier = identityFromRoom(hotel.rooms?.[0], lookup);
    const { rule } = pickHotelRule(primarySupplier, ruleMap);
    const priced = calculateMarkup(hotel.totalNet, rule.percent, rule.maxCap, currency);
    hotel.totalNet = priced.finalPrice;
  } else {
    recomputeHotelTotalPrice(hotel);
  }
  return hotel;
};

const collectMarkupHotelsFromPayload = (payload) => {
  const hotels = [];
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  for (const row of rows) {
    if (row?.hotel && typeof row.hotel === "object") {
      hotels.push(row.hotel);
      continue;
    }
    if (row && (Array.isArray(row.rooms) || row.totalPrice != null || row.propertyInfo)) {
      hotels.push(row);
    }
  }
  return hotels;
};

export const applyHotelMarkupsToSearchPayload = async (payload, { sources } = {}) => {
  const hotels = collectMarkupHotelsFromPayload(payload);
  if (!hotels.length) return payload;
  const lookup = buildSourceLookup(sources || []);
  const ruleMap = await loadRuleMap(collectIdentitiesFromHotels(hotels, lookup));
  for (const hotel of hotels) {
    await applyHotelMarkupsToHotel(hotel, { sources, ruleMap });
  }
  return payload;
};

export const prefetchHotelMarkupRules = async (payload, { sources } = {}) => {
  const hotels = collectMarkupHotelsFromPayload(payload);
  const lookup = buildSourceLookup(sources || []);
  return loadRuleMap(collectIdentitiesFromHotels(hotels, lookup));
};

export const applyHotelMarkupsOnResponse = async (payload, extra = {}) => {
  if (!payload || typeof payload !== "object") return payload;
  try {
    const sources = extra.sources ?? (await loadHotelModuleSources());
    await applyHotelMarkupsToSearchPayload(payload, { sources });
  } catch (error) {
    console.error(
      "[HOTEL MARKUP] applyHotelMarkupsOnResponse failed (returning net):",
      error?.message || error,
    );
  }
  return payload;
};

export const snapshotSupplierHotelPricing = (hotel) => {
  if (!hotel || typeof hotel !== "object") return null;
  return {
    totalNet: hotel.totalNet != null ? Number(hotel.totalNet) : null,
    rooms: Array.isArray(hotel.rooms) ? deepClone(hotel.rooms) : [],
  };
};

export const supplierNetFromHold = (hold) => {
  if (!hold) return null;
  const supplierTotalNet = Number(hold.supplierTotalNet);
  if (Number.isFinite(supplierTotalNet) && supplierTotalNet >= 0) return supplierTotalNet;
  const legacy = Number(hold.totalNet);
  return Number.isFinite(legacy) && legacy >= 0 ? legacy : null;
};

export const stripSupplierHoldFields = (row) => {
  if (!row || typeof row !== "object") return row;
  delete row.supplierTotalNet;
  delete row.supplierRooms;
  return row;
};

export const loadHotelModuleSources = async () => {
  if (sourceMem.sources && sourceMem.exp > Date.now()) return sourceMem.sources;

  try {
    const cached = await redis.get(MODULE_CONFIG_CACHE_KEY);
    if (cached) {
      const sources = JSON.parse(cached);
      sourceMem.sources = sources;
      sourceMem.exp = Date.now() + MODULE_CONFIG_TTL_SEC * 1000;
      return sources;
    }
  } catch (error) {
    console.error("[HOTEL MARKUP] module-config redis get failed:", error?.message || error);
  }

  try {
    const response = await axios.get(
      `${process.env.INTERNAL_BASE_URL}/internal/module-config?module=hotels`,
      {
        headers: {
          "X-Internal-Api-Key": process.env.INTERNAL_SUPPLIER_ROUTING_KEY,
        },
        timeout: 4000,
      },
    );
    const sources = response?.data?.items?.[0]?.sources || [];
    sourceMem.sources = sources;
    sourceMem.exp = Date.now() + MODULE_CONFIG_TTL_SEC * 1000;
    try {
      await redis.set(
        MODULE_CONFIG_CACHE_KEY,
        JSON.stringify(sources),
        "EX",
        MODULE_CONFIG_TTL_SEC,
      );
    } catch (error) {
      console.error("[HOTEL MARKUP] module-config redis set failed:", error?.message || error);
    }
    return sources;
  } catch (error) {
    console.error(
      "[HOTEL MARKUP] Failed to load hotel module-config:",
      error?.response?.data || error.message,
    );
    return sourceMem.sources || [];
  }
};
