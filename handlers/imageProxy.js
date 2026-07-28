import axios from "axios";
import { globalHeaders, InternalError } from "../helper/helper.js";

export const handler = async (event) => {
    try {
       
        const query = event.queryStringParameters || {};
        const { imageUrl } = query;

        // --- validation (your existing code) ---
        if (!imageUrl) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "imageUrls idddds required" }),
            };
        }

        const response = await axios.get(imageUrl, {
            responseType: "arraybuffer",
        });

        console.log("response*********dd**", response);

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: Buffer.from(response.data).toString("base64")
        };

    } catch (error) {
        console.error("Error in get more rooms:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
