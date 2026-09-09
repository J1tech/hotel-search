import redis from "../lib/redisClient.js";

const stage = () => process.env.STAGE || "dev";

/** e.g. hotel:poller:dev: / hotel:poller:qa: */
export const hotelPollerKeyPrefix = () => `hotel:poller:${stage()}:`;

export const HOTEL_PENDING_POLL_STATUSES = [
  "ON REQUEST",
  "IN PROGRESS",
  "OK TO TICKET Non-Air",
];

export const HOTEL_TERMINAL_STOP_STATUSES = [
  "NOT AVAILABLE",
  "CANCELLED",
  "CANCELLED BY USER",
  "REJECTED",
];

const pollIntervalMs = () =>
  Number(process.env.HOTEL_STATUS_POLL_INTERVAL_MS || 5 * 60 * 1000);

const pollBatchSize = () =>
  Number(process.env.HOTEL_STATUS_POLL_BATCH_SIZE || 10);

const pollMaxDue = () =>
  Number(process.env.HOTEL_STATUS_POLL_MAX_DUE || 50);

const pollMaxAgeMs = () =>
  Number(process.env.HOTEL_STATUS_POLL_MAX_AGE_MS || 48 * 60 * 60 * 1000);

const pollLockTtlSec = () =>
  Number(process.env.HOTEL_STATUS_POLL_LOCK_TTL_SEC || 900);

const reconcileIntervalMs = () =>
  Number(process.env.HOTEL_STATUS_POLL_RECONCILE_INTERVAL_MS || 24 * 60 * 60 * 1000);

const zsetKey = () => `${hotelPollerKeyPrefix()}pending`;
const payloadKey = (member) => `${hotelPollerKeyPrefix()}payload:${member}`;
const lockKey = () => `${hotelPollerKeyPrefix()}lock`;
const reconcileKey = () => `${hotelPollerKeyPrefix()}reconcile:lastRun`;

export const pollMemberId = (bookingReferenceId, hotelKey) =>
  `${String(bookingReferenceId).trim()}|${String(hotelKey).trim()}`;

export const isHotelPendingPollStatus = (status) =>
  HOTEL_PENDING_POLL_STATUSES.includes(String(status || "").trim());

export const isHotelTerminalStopStatus = (status) => {
  const norm = String(status || "").trim().toUpperCase();
  return HOTEL_TERMINAL_STOP_STATUSES.some((s) => s.toUpperCase() === norm);
};

export const getPollConfig = () => ({
  pollIntervalMs: pollIntervalMs(),
  pollBatchSize: pollBatchSize(),
  pollMaxDue: pollMaxDue(),
  pollMaxAgeMs: pollMaxAgeMs(),
});

const backoffMs = (retryCount) => {
  const base = pollIntervalMs();
  if (retryCount <= 1) return base;
  if (retryCount === 2) return base * 3;
  if (retryCount === 3) return base * 6;
  return base * 12;
};

export const enqueuePendingHotelPoll = async ({
  bookingReferenceId,
  hotelKey,
  bookingKey = "",
  searchKey = "",
  clientReferenceId = "",
  userId = "",
  userType = "",
  lastKnownStatus = "",
  enqueuedAt,
}) => {
  if (!bookingReferenceId || !hotelKey) {
    console.warn("enqueuePendingHotelPoll: missing bookingReferenceId or hotelKey");
    return false;
  }
  if (!isHotelPendingPollStatus(lastKnownStatus)) {
    return false;
  }

  const member = pollMemberId(bookingReferenceId, hotelKey);
  const now = Date.now();
  const payload = {
    productType: "H",
    bookingReferenceId: String(bookingReferenceId),
    hotelKey: String(hotelKey),
    bookingKey: String(bookingKey || ""),
    searchKey: String(searchKey || ""),
    clientReferenceId: String(clientReferenceId || ""),
    userId: String(userId || ""),
    userType: String(userType || ""),
    lastKnownStatus: String(lastKnownStatus || ""),
    enqueuedAt: enqueuedAt || new Date(now).toISOString(),
    retryCount: 0,
  };

  const pipeline = redis.pipeline();
  pipeline.zadd(zsetKey(), now + pollIntervalMs(), member);
  pipeline.set(payloadKey(member), JSON.stringify(payload));
  await pipeline.exec();
  console.log("Enqueued hotel pending poll:", member, payload.lastKnownStatus);
  return true;
};

export const removePendingHotelPoll = async (bookingReferenceId, hotelKey) => {
  if (!bookingReferenceId || !hotelKey) return;
  const member = pollMemberId(bookingReferenceId, hotelKey);
  const pipeline = redis.pipeline();
  pipeline.zrem(zsetKey(), member);
  pipeline.del(payloadKey(member));
  await pipeline.exec();
};

export const reschedulePendingHotelPoll = async (member, payload, retryCount = 0) => {
  const delay = backoffMs(retryCount);
  const nextPayload = {
    ...payload,
    retryCount,
    lastCheckedAt: new Date().toISOString(),
  };
  const pipeline = redis.pipeline();
  pipeline.zadd(zsetKey(), Date.now() + delay, member);
  pipeline.set(payloadKey(member), JSON.stringify(nextPayload));
  await pipeline.exec();
};

export const updatePendingPollPayload = async (member, payload) => {
  await redis.set(payloadKey(member), JSON.stringify(payload));
};

export const acquireHotelPollLock = async (ownerId) => {
  const acquired = await redis.set(lockKey(), ownerId, "EX", pollLockTtlSec(), "NX");
  return acquired === "OK";
};

export const releaseHotelPollLock = async (ownerId) => {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;
  await redis.eval(script, 1, lockKey(), ownerId);
};

export const fetchDuePendingPolls = async (limit = pollMaxDue()) => {
  const now = Date.now();
  const members = await redis.zrangebyscore(zsetKey(), 0, now, "LIMIT", 0, limit);
  if (!members.length) return [];

  const pipeline = redis.pipeline();
  for (const member of members) {
    pipeline.get(payloadKey(member));
  }
  const results = await pipeline.exec();

  const items = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const [, raw] = results[i] || [];
    if (!raw) {
      await redis.zrem(zsetKey(), member);
      continue;
    }
    try {
      items.push({ member, payload: JSON.parse(raw) });
    } catch {
      await removePendingHotelPoll(...member.split("|"));
    }
  }
  return items;
};

export const shouldRunReconcile = async () => {
  const last = await redis.get(reconcileKey());
  if (!last) return true;
  return Date.now() - Number(last) >= reconcileIntervalMs();
};

export const markReconcileComplete = async () => {
  await redis.set(reconcileKey(), String(Date.now()));
};

export const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};
