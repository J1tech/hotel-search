import axios from "axios";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import redis from "./redisClient.js";
import { createCacheKey } from "./cacheKey.js";

const PLACES_BASE = "https://places.googleapis.com/v1";
export const LOCATION_RADIUS_METERS = 300;
const EARTH_RADIUS_METERS = 6371000;
const REVIEWS_CACHE_TTL_SECONDS = Number(process.env.GOOGLE_REVIEWS_CACHE_TTL || 21600);
const dynamo = new DynamoDBClient({ region: process.env.REGION || process.env.region });

function roundCoord(value) {
    return Number(Number(value).toFixed(4));
}

function toRad(degrees) {
    return (degrees * Math.PI) / 180;
}

export function distanceMeters(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export function isWithinRadius(requestLat, requestLng, placeLat, placeLng) {
    if (![requestLat, requestLng, placeLat, placeLng].every(Number.isFinite)) return false;
    return distanceMeters(requestLat, requestLng, placeLat, placeLng) <= LOCATION_RADIUS_METERS;
}

function readGoogleLocation(location) {
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
}

export function placeLookupHash({ hotelName, city, latitude, longitude }) {
    return createCacheKey(
        {
            hotelName: hotelName.trim().toLowerCase(),
            city: city.trim().toLowerCase(),
            latitude: roundCoord(latitude),
            longitude: roundCoord(longitude),
        },
        "googlePlace"
    );
}

/** One Dynamo/Redis PK when both are present. Null if either is missing — caller must use the hash instead. */
export function placePairKey(supplier, providerHotelId) {
    const supplierCode = String(supplier ?? "").trim().toUpperCase();
    const hotelId = String(providerHotelId ?? "").trim();
    if (!supplierCode || !hotelId) return null;
    return `pair:${supplierCode}:${hotelId}`;
}

function reviewsCacheKey(lookupKey, language) {
    return `googleReviews:${lookupKey}:${language}`;
}

function googleHeaders(fieldMask) {
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
    };
}

export async function getSavedPlaceId(placeLookupHash) {
    const table = process.env.HOTEL_GOOGLE_PLACES_TABLE;
    if (!table) return null;
    try {
        const { Item } = await dynamo.send(
            new GetItemCommand({
                TableName: table,
                Key: marshall({ placeLookupHash }),
            })
        );
        if (!Item) return null;
        const row = unmarshall(Item);
        return row.placeId ? { placeId: row.placeId, displayName: row.displayName || null } : null;
    } catch (error) {
        console.error("Dynamo GET placeId error:", error.message);
        return null;
    }
}

export async function getSavedPlaceIdByKeys(pairKey, hashKey) {
    const [pairHit, hashHit] = await Promise.all([
        pairKey ? getSavedPlaceId(pairKey) : Promise.resolve(null),
        getSavedPlaceId(hashKey),
    ]);
    return pairHit || hashHit;
}

export async function savePlaceId({
    placeLookupHash,
    placeId,
    displayName,
    hotelName,
    city,
    latitude,
    longitude,
    supplier,
    providerHotelId,
}) {
    const table = process.env.HOTEL_GOOGLE_PLACES_TABLE;
    if (!table) return;
    try {
        await dynamo.send(
            new PutItemCommand({
                TableName: table,
                Item: marshall(
                    {
                        placeLookupHash,
                        placeId,
                        displayName: displayName || hotelName,
                        hotelName,
                        city,
                        latitude: roundCoord(latitude),
                        longitude: roundCoord(longitude),
                        supplier: supplier || undefined,
                        providerHotelId: providerHotelId || undefined,
                        updatedAt: new Date().toISOString(),
                    },
                    { removeUndefinedValues: true }
                ),
            })
        );
    } catch (error) {
        console.error("Dynamo PUT placeId error:", error.message);
    }
}

export async function searchGooglePlace({ hotelName, city, latitude, longitude, language }) {
    const { data } = await axios.post(
        `${PLACES_BASE}/places:searchText`,
        {
            textQuery: `${hotelName} ${city}`.trim(),
            languageCode: language,
            includedType: "lodging",
            strictTypeFiltering: true,
            pageSize: 1,
            locationBias: {
                circle: {
                    center: { latitude, longitude },
                    radius: LOCATION_RADIUS_METERS,
                },
            },
        },
        {
            timeout: 15000,
            headers: googleHeaders("places.id,places.displayName,places.location"),
        }
    );
    const place = data?.places?.[0];
    if (!place?.id) return null;
    const location = readGoogleLocation(place.location);
    return {
        placeId: place.id,
        displayName: place.displayName?.text || hotelName,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
    };
}

function mapReview(review) {
    return {
        rating: review?.rating ?? null,
        text: review?.text?.text || review?.originalText?.text || "",
        originalText: review?.originalText?.text || "",
        publishTime: review?.publishTime || null,
        relativePublishTimeDescription: review?.relativePublishTimeDescription || "",
        author: {
            displayName: review?.authorAttribution?.displayName || "",
            uri: review?.authorAttribution?.uri || "",
            photoUri: review?.authorAttribution?.photoUri || "",
        },
        googleMapsUri: review?.googleMapsUri || "",
    };
}

export function sortReviewsNewest(reviews) {
    return [...reviews].sort((a, b) => {
        const aTime = a.publishTime ? Date.parse(a.publishTime) : 0;
        const bTime = b.publishTime ? Date.parse(b.publishTime) : 0;
        return bTime - aTime;
    });
}

export async function getGooglePlaceReviews(placeId, language) {
    const { data } = await axios.get(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
        timeout: 15000,
        params: { languageCode: language },
        headers: googleHeaders("id,displayName,location,rating,userRatingCount,googleMapsUri,reviews"),
    });
    const location = readGoogleLocation(data?.location);
    const reviews = sortReviewsNewest((data?.reviews || []).map(mapReview));
    return {
        placeId: data?.id || placeId,
        displayName: data?.displayName?.text || "",
        rating: data?.rating ?? null,
        userRatingCount: data?.userRatingCount ?? 0,
        googleMapsUri: data?.googleMapsUri || "",
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        reviews,
    };
}

export function reviewsPayload(details) {
    return {
        placeId: details.placeId,
        displayName: details.displayName,
        rating: details.rating,
        userRatingCount: details.userRatingCount,
        googleMapsUri: details.googleMapsUri,
        reviews: details.reviews,
    };
}

export async function getCachedReviews(lookupKey, language) {
    if (!lookupKey) return null;
    try {
        const raw = await redis.get(reviewsCacheKey(lookupKey, language));
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.error("Redis GET reviews error:", error.message);
        return null;
    }
}

export async function getCachedReviewsByKeys(pairKey, hashKey, language) {
    const [pairHit, hashHit] = await Promise.all([
        getCachedReviews(pairKey, language),
        getCachedReviews(hashKey, language),
    ]);
    return pairHit || hashHit;
}

export async function cacheReviews(lookupKey, language, payload) {
    if (!lookupKey) return;
    try {
        await redis.set(
            reviewsCacheKey(lookupKey, language),
            JSON.stringify(payload),
            "EX",
            REVIEWS_CACHE_TTL_SECONDS
        );
    } catch (error) {
        console.error("Redis SET reviews error:", error.message);
    }
}
