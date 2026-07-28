// lib/redisClient.js
import Redis from "ioredis";

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS = process.env.REDIS_TLS === "true"; // if using encryption

let redisClient;

// Create singleton client (Lambda cold-start only)
if (!redisClient) {
  const opts = {
    host: REDIS_HOST,
    port: Number(REDIS_PORT),
    password: REDIS_PASSWORD,
    // If using TLS/Encryption (e.g., Amazon MemoryDB), set tls: {}
    tls: REDIS_TLS ? {} : undefined,
    // enable offline queue: true by default
  };

  redisClient = new Redis(opts);
  redisClient.on("error", (err) => {
    console.error("Redis error", err);
  });
  redisClient.on("connect", () => {
    console.info("Redis connected");
  });
}

export default redisClient;
