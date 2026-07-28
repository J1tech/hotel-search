import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.REGION });

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

export const handler = async (event) => {
    try {

        const statuses = [
            "ON REQUEST",
            "IN PROGRESS",
            "OK TO TICKET Non-Air"
        ];

        const results = [];

        for (const status of statuses) {
            const params = {
                TableName: process.env.HOTEL_BOOK_TABLE,
                IndexName: "bookingStatus-index",
                KeyConditionExpression: "#status = :status",
                ExpressionAttributeNames: {
                    "#status": "bookingStatus"
                },
                ExpressionAttributeValues: {
                    ":status": { S: status }   // ✅ FIX
                }
            };

            const data = await dynamo.send(new QueryCommand(params));

            if (data.Items) {
                const items = data.Items.map(item => unmarshall(item)); // ✅ FIX
                results.push(...items);
            }
        }

        console.log("Final Results:", results)

        if (results.length > 0) {

            // ✅ Get session once (not inside loop)
            const { sessionId, conversationId } = await getSessionId();

            if (!sessionId || !conversationId) {
                return {
                    ...globalHeaders(),
                    statusCode: 500,
                    body: JSON.stringify({
                        message: "Login failed, missing sessionId or conversationId"
                    }),
                };
            }

            console.log("sessionId:", sessionId);
            console.log("conversationId:", conversationId);

            // ✅ Parallel processing (faster)
            const responses = await Promise.allSettled(
                results.map(async (element) => {

                    const payload = {
                        productType: "H",
                        bookingReferenceId: element.bookingReferenceId,
                        clientReferenceId: "",
                        bookingKey: "",
                        searchKey: element.searchKey
                    };

                    try {
                        const resp = await axios.post(
                            `${BASE_URL}/reservation/hotel-book-retrieve`,
                            payload,
                            {
                                timeout: 45000,
                                headers: {
                                    "Content-Type": "application/json",
                                    "X-API-KEY": process.env.X_API_KEY,
                                    conversationId,
                                    sessionId,
                                },
                            }
                        );

                        console.log("Success*********************:", element.bookingReferenceId);
                        console.log("element.hotelKey********", element.hotelKey);

                        console.log("resp.data**********", JSON.stringify(resp.data, null, 2));
                        const data = resp.data?.data?.[0];
                        console.log("data?.bookingStatus***********", data?.bookingStatus);

                        const escalateSupplierFlag = !["VOUCHERED", "CONFIRMED"].includes(data?.bookingStatus);
                        console.log("escalateSupplierFlag***********", escalateSupplierFlag, element.bookingReferenceId);

                        const updateCmd = new UpdateItemCommand({
                            TableName: process.env.HOTEL_BOOK_TABLE,
                            Key: {
                                bookingReferenceId: { S: element.bookingReferenceId },
                                hotelKey: { S: element.hotelKey }
                            },
                            UpdateExpression: "SET #esf = :escalateSupplierFlag, #bs = :bookingStatus",
                            ExpressionAttributeNames: {
                                "#esf": "escalateSupplierFlag",
                                "#bs": "bookingStatus"
                            },
                            ExpressionAttributeValues: {
                                ":escalateSupplierFlag": { BOOL: escalateSupplierFlag },
                                ":bookingStatus": { S: data.bookingStatus }
                            }
                        });

                        await dynamo.send(updateCmd);

                        return {
                            success: true,
                            bookingReferenceId: element.bookingReferenceId,
                            data: resp.data
                        };

                    } catch (error) {
                        console.error("Failed:", element.bookingReferenceId, error?.response?.data || error.message);

                        return {
                            success: false,
                            bookingReferenceId: element.bookingReferenceId,
                            error: error?.response?.data || error.message
                        };
                    }
                })
            );

            // ✅ Separate success & failed
            const success = responses
                .filter(r => r.status === "fulfilled" && r.value.success)
                .map(r => r.value);

            const failed = responses
                .filter(r => r.status === "fulfilled" && !r.value.success)
                .map(r => r.value);

            console.log("Success count:", success.length);
            console.log("Failed count:", failed.length);

            return {
                successCount: success.length,
                failedCount: failed.length,
                success,
                failed
            };
        }

    } catch (error) {
        console.error("Error in get more rooms:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
