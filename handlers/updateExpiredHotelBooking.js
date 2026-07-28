import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// ── Constants ────────────────────────────────────────────────────────────────
const TABLE_NAME = process.env.HOTEL_PRE_BOOK_TABLE; // replace with your table name
const INDEX_NAME = "status-bookingKey-index";
const SORT_KEY_VALUE = "DEFAULT"; // hard-coded sort key
const EXPIRY_THRESHOLD_MS = 14 * 60 * 1000; // 15 minutes in milliseconds

// ── DynamoDB client ──────────────────────────────────────────────────────────
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// ── Main handler ─────────────────────────────────────────────────────────────
export const handler = async (event) => {
  console.log("SQS Event received:", JSON.stringify(event, null, 2));

  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  // Log any failures without failing the whole batch
  results.forEach((result, idx) => {
    if (result.status === "rejected") {
      console.error(`Record [${idx}] failed:`, result.reason);
    }
  });

  return { batchItemFailures: buildFailures(event.Records, results) };
};

// ── Per-record logic ─────────────────────────────────────────────────────────
async function processRecord(record) {
  const body = JSON.parse(record.body);
  const { bookingKey } = body;

  if (!bookingKey) {
    throw new Error(`Missing bookingKey in SQS message body: ${record.body}`);
  }

  console.log(`Processing bookingKey: ${bookingKey}`);

  // 1. Query DynamoDB via GSI (status-bookingKey-index) for Active bookings
  const bookings = await queryActiveBookings(bookingKey);

  if (!bookings.length) {
    console.log(`No active bookings found for bookingKey: ${bookingKey}`);
    return;
  }

  // 2. Check each booking's createdAt and expire if >= 15 min old
  const now = Date.now();

  await Promise.all(
    bookings.map(async (booking) => {
      const createdAt = new Date(booking.createdAt).getTime();
      const ageMs = now - createdAt;

      if (ageMs >= EXPIRY_THRESHOLD_MS) {
        console.log(
          `Booking ${booking.bookingReferenceId} is ${Math.round(ageMs / 60000)} min old — marking expired`
        );
        await expireBooking(booking.bookingKey, booking.bookingReferenceId);
      } else {
        console.log(
          `Booking ${booking.bookingReferenceId} is ${Math.round(ageMs / 60000)} min old — not yet expired`
        );
      }
    })
  );
}

// ── DynamoDB: Query via GSI ──────────────────────────────────────────────────
async function queryActiveBookings(bookingKey) {
  const params = {
    TableName: TABLE_NAME,
    IndexName: INDEX_NAME,
    KeyConditionExpression: "#status = :status AND bookingKey = :bookingKey",
    ExpressionAttributeNames: {
      "#status": "status", // 'status' is a reserved word in DynamoDB
    },
    ExpressionAttributeValues: {
      ":status": "pending",
      ":bookingKey": bookingKey,
    },
  };

  console.log("Querying GSI with params:", JSON.stringify(params, null, 2));

  const response = await docClient.send(new QueryCommand(params));
  console.log(`Found ${response.Items?.length ?? 0} active booking(s)`);

  return response.Items ?? [];
}

// ── DynamoDB: Update status to Expired ──────────────────────────────────────
async function expireBooking(bookingKey, bookingReferenceId) {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      bookingKey
    },
    UpdateExpression:
      "SET #status = :expired, updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":expired": "expired",
      ":updatedAt": new Date().toISOString(),
    },
    ReturnValues: "UPDATED_NEW",
  };

  try {
    const response = await docClient.send(new UpdateCommand(params));
    console.log(
      `Successfully expired booking — bookingKey: ${bookingKey}, bookingReferenceId: ${SORT_KEY_VALUE}`,
      response.Attributes
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      // Another process already updated this item — safe to ignore
      console.warn(
        `Booking ${bookingKey}/${SORT_KEY_VALUE} was already updated by another process`
      );
    } else {
      throw error;
    }
  }
}

// ── Partial batch failure reporting ─────────────────────────────────────────
function buildFailures(records, results) {
  return results
    .map((result, idx) =>
      result.status === "rejected"
        ? { itemIdentifier: records[idx].messageId }
        : null
    )
    .filter(Boolean);
}