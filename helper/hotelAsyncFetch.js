import axios from "axios";

const BASE_URL = process.env.BASE_URL;
const ASYNC_POLL_INTERVAL_MS = Number(process.env.ASYNC_POLL_INTERVAL_MS || 3000);

export const isHotelFetchLater = (data) =>
  Number(data?.meta?.statusCode) === 2 && Boolean(data?.asyncFetch?.fetchUrl);

export const isTransientHotelBookError = (error) => {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    /timeout/i.test(msg) ||
    /socket hang up/i.test(msg)
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follow Provesio hotel-book FETCH LATER until success, deadline, or a hard error.
 * Returns the final body, or null if still pending when time runs out (keep confirm lock).
 */
export async function pollHotelBookFetchLater({
  fetchUrl,
  sessionId,
  conversationId,
  deadlineMs,
}) {
  const fullUrl = `${BASE_URL}${fetchUrl}`;
  let attempt = 0;

  while (Date.now() + 2000 < deadlineMs) {
    attempt += 1;
    const wait = Math.min(ASYNC_POLL_INTERVAL_MS, Math.max(0, deadlineMs - Date.now() - 16000));
    if (wait > 0) await sleep(wait);

    if (Date.now() + 1500 >= deadlineMs) break;

    console.log(`Hotel book FETCH LATER poll ${attempt}: ${fullUrl}`);
    const pollResp = await axios.get(fullUrl, {
      timeout: Math.min(15000, Math.max(2000, deadlineMs - Date.now())),
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.X_API_KEY,
        conversationId,
        sessionId,
      },
    });

    const statusCode = pollResp.data?.meta?.statusCode;
    if (statusCode === 2) {
      console.log(`Hotel book FETCH LATER poll ${attempt}: still pending`);
      continue;
    }
    if (pollResp.data?.meta?.success === true) {
      console.log(`Hotel book FETCH LATER poll ${attempt}: final result`);
      return pollResp.data;
    }
    throw new Error(
      `Unexpected hotel book poll response on attempt ${attempt}: ${JSON.stringify(pollResp.data?.meta)}`,
    );
  }

  console.warn("Hotel book FETCH LATER still pending at Lambda deadline; keeping confirm lock");
  return null;
}
