import axios from "axios";

const UNIFIED_SESSION_TTL_SECONDS = 900;

function unifiedApiBase() {
    return process.env.UNIFIED_SESSIONS_API_BASE?.replace(/\/$/, "") || "";
}

export async function createUnifiedPaymentSession({
    product,
    bookingId,
    snapshot,
    paymentDetails,
}) {
    const apiBase = unifiedApiBase();
    const writeSecret = process.env.UNIFIED_SESSIONS_WRITE_SECRET;
    if (!apiBase || !writeSecret) {
        throw new Error("Unified payment sessions are not configured");
    }

    const unifiedRes = await axios.post(
        `${apiBase}/api/v1/session`,
        {
            tokenType: "EXISTING_BOOKING_PAYMENT",
            product,
            bookingId,
            snapshot,
            paymentDetails,
            ttlSeconds: UNIFIED_SESSION_TTL_SECONDS,
        },
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${writeSecret}`,
            },
            validateStatus: () => true,
            timeout: 15_000,
        }
    );

    if (unifiedRes.status === 409) {
        const err = new Error(unifiedRes.data?.message || "Already paid");
        err.statusCode = 409;
        err.code = unifiedRes.data?.code || "PAID";
        throw err;
    }

    if (unifiedRes.status >= 400) {
        const message =
            unifiedRes.data?.message ||
            unifiedRes.data?.error ||
            "Failed to create unified payment session";
        const err = new Error(message);
        err.statusCode = unifiedRes.status >= 500 ? 502 : unifiedRes.status;
        throw err;
    }

    const data = unifiedRes.data || {};
    const sessionToken = data.token ?? data.sessionToken;
    if (!sessionToken) {
        throw new Error("Unified session create returned invalid response");
    }

    return {
        sessionToken,
        expiresAt: data.expiresAt,
        shareUrl: data.shareUrl,
        reused: Boolean(data.reused),
    };
}

export async function markUnifiedSessionPaid(sessionToken) {
    const token = String(sessionToken ?? "").trim();
    if (!token) return;

    const apiBase = unifiedApiBase();
    const writeSecret = process.env.UNIFIED_SESSIONS_WRITE_SECRET;
    if (!apiBase || !writeSecret) {
        console.warn("Unified sessions mark-paid skipped: missing API base or write secret");
        return;
    }

    const res = await axios.post(
        `${apiBase}/api/v1/session/mark-paid`,
        { token },
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${writeSecret}`,
            },
            validateStatus: () => true,
            timeout: 15_000,
        }
    );

    if (res.status >= 400) {
        throw new Error(
            `Unified mark-paid failed (${res.status}): ${
                typeof res.data === "object" ? JSON.stringify(res.data) : res.data
            }`
        );
    }
}
