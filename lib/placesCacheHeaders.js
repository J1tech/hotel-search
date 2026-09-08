const AUTocomplete_TTL = Number(process.env.GEO_PLACES_AUTOCOMPLETE_CACHE_TTL || 259200);
const DETAILS_TTL = Number(process.env.GEO_PLACES_DETAILS_CACHE_TTL || 604800);

export function getPlacesAutocompleteCacheControl() {
    const swr = Math.min(86400, Math.max(3600, Math.floor(AUTocomplete_TTL / 3)));
    return `public, max-age=${AUTocomplete_TTL}, stale-while-revalidate=${swr}`;
}

export function getPlacesDetailsCacheControl() {
    const swr = Math.min(86400, Math.max(3600, Math.floor(DETAILS_TTL / 7)));
    return `public, max-age=${DETAILS_TTL}, stale-while-revalidate=${swr}`;
}

export const PLACES_NO_STORE = "no-store";
