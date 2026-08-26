import { globalHeaders, InternalError } from "../helper/helper.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
    parseMaybeJson,
    buildHotelEmailPayload,
    resolveHotelBookBookingKey,
} from "../helper/hotelEmailPayload.js";

const region = process.env.REGION;
const dynamo = new DynamoDBClient({ region });
const sqsClient = new SQSClient({ region });

const getStoredBook = async (bookingReferenceId, hotelKey) => {
    if (!process.env.HOTEL_BOOK_TABLE || !bookingReferenceId || !hotelKey) return {};
    const result = await dynamo.send(
        new GetItemCommand({
            TableName: process.env.HOTEL_BOOK_TABLE,
            Key: {
                bookingReferenceId: { S: String(bookingReferenceId) },
                hotelKey: { S: String(hotelKey) },
            },
        })
    );
    return result.Item ? unmarshall(result.Item) : {};
};

const getPreBook = async (bookingKey) => {
    if (!process.env.HOTEL_PRE_BOOK_TABLE || !bookingKey) return {};
    const result = await dynamo.send(
        new GetItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: { bookingKey: { S: String(bookingKey) } },
        })
    );
    return result.Item ? unmarshall(result.Item) : {};
};

const getHotelDetail = async (hotelKey) => {
    if (!process.env.LOG_TRACE_TABLE || !hotelKey) return {};
    const result = await dynamo.send(
        new QueryCommand({
            TableName: process.env.LOG_TRACE_TABLE,
            IndexName: "GSI_Hotel_Step",
            KeyConditionExpression: "hotelKey = :hotelKey AND stepCode = :stepCode",
            ExpressionAttributeValues: {
                ":hotelKey": { S: String(hotelKey) },
                ":stepCode": { N: "120" },
            },
            Limit: 1,
        })
    );
    const item = result.Items?.[0] ? unmarshall(result.Items[0]) : {};
    return parseMaybeJson(item.response) || {};
};

const getUserDetails = async (userId) => {
    if (!process.env.USERS_TABLE || !userId) return {};
    const result = await dynamo.send(
        new QueryCommand({
            TableName: process.env.USERS_TABLE,
            KeyConditionExpression: "userId = :uid",
            ExpressionAttributeValues: { ":uid": { S: String(userId) } },
            Limit: 1,
        })
    );
    return result.Items?.[0] ? unmarshall(result.Items[0]) : {};
};

export const handler = async (event, context) => {
    try {
        const requestId = context.awsRequestId;
        console.log("AWS Request ID:", requestId);

        for (const record of event.Records) {
            const body = parseMaybeJson(record.body) || {};
            console.log("hotel email queue body", JSON.stringify(body));

            let { hotelBookingData, userId } = body;
            hotelBookingData = parseMaybeJson(hotelBookingData);
            const booking = hotelBookingData?.data?.[0] || hotelBookingData || {};
            const hotelKey = booking?.hotel?.hotelKey || booking?.hotelKey;
            const bookingReferenceId = booking?.bookingReferenceId;

            const [userDetails, storedBook, hotelDetail] = await Promise.all([
                getUserDetails(userId),
                getStoredBook(bookingReferenceId, hotelKey),
                getHotelDetail(hotelKey),
            ]);

            const bookingKey = resolveHotelBookBookingKey({
                ...storedBook,
                bookingKey: booking.bookingKey || storedBook.bookingKey,
                request: storedBook.request || booking.request,
            });
            const preBook = await getPreBook(bookingKey);

            const emailData = buildHotelEmailPayload({
                booking,
                storedBook,
                preBook,
                hotelDetail,
                userDetails,
            });

            console.log("assembled hotel emailData", JSON.stringify(emailData, null, 2));

            if (!emailData.email) {
                console.log("No recipient email found, skipping SEND_EMAIL_QUEUE");
                continue;
            }
            if (!emailData.bookingReferenceId) {
                console.log("No bookingReferenceId found, skipping SEND_EMAIL_QUEUE");
                continue;
            }
            if (!process.env.SEND_EMAIL_QUEUE) {
                console.log("SEND_EMAIL_QUEUE is not set, skipping SES enqueue");
                continue;
            }

            await sqsClient.send(
                new SendMessageCommand({
                    QueueUrl: process.env.SEND_EMAIL_QUEUE,
                    MessageBody: JSON.stringify(emailData),
                })
            );
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
        };
    } catch (error) {
        console.log("error*********", error);
        return await InternalError(error);
    }
};
