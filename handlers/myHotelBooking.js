import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.REGION });
export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        console.log(JSON.stringify(authVerification, null, 2));
        if (authVerification?.principalId === "unknown") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Invalid or expired token",
                }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        const allowedStatus = ["pending", "expired", "confirmed", "all", "cancelled"];
        const { status } = body;
        let params = {}
        if (!status) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "Missing required field: status" }),
            };
        }

        if (!allowedStatus.includes(status)) {
            return {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true,
                },
                statusCode: 400,
                ...globalHeaders(),
                body: JSON.stringify({
                    message: `Invalid status. Allowed values are: ${allowedStatus.join(", ")}`
                }),
            };
        }


        if (status == 'all') {
            params = {
                TableName: process.env.HOTEL_PRE_BOOK_TABLE,
                IndexName: "userId-status-index",
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: {
                    ":uid": { S: authVerification?.context?.sub }
                }
            };

        }
        else {
            params = {
                TableName: process.env.HOTEL_PRE_BOOK_TABLE,
                IndexName: "userId-status-index",
                KeyConditionExpression: "userId = :uid AND #st = :status",
                ExpressionAttributeNames: {
                    "#st": "status"
                },
                ExpressionAttributeValues: {
                    ":uid": { S: authVerification?.context?.sub },
                    ":status": { S: status }
                }
            };
        }

        const result = await dynamo.send(new QueryCommand(params));

        // Safety check
        const items = result.Items ?? [];
        const parsedItems = await Promise.all(
            items.map(async (item) => {
                const unmarshalled = unmarshall(item);
                const hotelKey = unmarshalled?.hotelKey;

                const params = {
                    TableName: process.env.LOG_TRACE_TABLE,
                    IndexName: "GSI_Hotel_Step",
                    KeyConditionExpression: "hotelKey = :ht AND stepCode = :st",
                    ExpressionAttributeValues: {
                        ":ht": { S: hotelKey },
                        ":st": { N: "120" }
                    }
                };

                const hotelDetail = await dynamo.send(new QueryCommand(params));
                const hotelDetailItems = hotelDetail.Items || [];

                const hotelDetailResult =
                    hotelDetailItems.length > 0
                        ? unmarshall(hotelDetailItems[0])
                        : null;

                let parseHotelResponse = null;

                try {
                    parseHotelResponse =
                        typeof hotelDetailResult?.response === "string"
                            ? JSON.parse(hotelDetailResult.response)
                            : hotelDetailResult?.response;
                } catch (e) {
                    console.error("Invalid JSON:", e);
                }

                const hotelImages = parseHotelResponse?.data?.[0]?.images || [];

                return parseStringifiedJSON({
                    ...unmarshalled,
                    hotelImages
                });
            })
        );
        // console.log(parsedItems);

        // const parsedItems = items.map((item) => {
        //     const data = unmarshall(item);

        //     // Parse stringified JSON fields
        //     ["passengers", "request", "rooms", "verifiedPropertyInfo"].forEach((field) => {
        //         if (typeof data[field] === "string") {
        //             try {
        //                 data[field] = JSON.parse(data[field]);
        //             } catch (err) {
        //                 // ignore parsing error
        //             }
        //         }
        //     });

        //     // Parse and add flightDetails
        //     data.flightDetails = (logItems ?? []).map((logItem) => {
        //         const logData = unmarshall(logItem);

        //         if (typeof logData.request === "string") {
        //             try {
        //                 logData.request = JSON.parse(logData.request);
        //             } catch (err) {
        //                 // ignore parsing error
        //             }
        //         }

        //         return logData;
        //     });

        //     return data;
        // });

        const sortedItems = parsedItems
            .filter(Boolean)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                count: sortedItems.Count,
                items: sortedItems,
            }),
        };
    } catch (error) {
        console.error("Record failed", {
            error: error.message,
            stack: error.stack,
        });
        return await InternalError(error)
    }
};


function parseStringifiedJSON(obj) {
    for (const key in obj) {
        if (typeof obj[key] === "string") {
            try {
                obj[key] = JSON.parse(obj[key]);
            } catch (err) {
                // Not a JSON string, leave as is
            }
        } else if (typeof obj[key] === "object" && obj[key] !== null) {
            parseStringifiedJSON(obj[key]);
        }
    }
    return obj;
}