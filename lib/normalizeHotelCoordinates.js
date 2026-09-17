/**
 * Read normalized lat/lng from a hotel search row (Provesio propertyInfo).
 * Returns null when coordinates are missing or invalid — never guess.
 */
export function readHotelCoordinates(hotel) {
    const info = hotel?.propertyInfo ?? hotel;
    const latitude = Number(info?.latitude ?? info?.lat);
    const longitude = Number(info?.longitude ?? info?.lng ?? info?.lon);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return null;
    }

    return { latitude, longitude };
}

/**
 * Attach normalized coordinates on the hotel row for FE map convenience.
 */
export function enrichHotelWithCoordinates(hotel) {
    const coords = readHotelCoordinates(hotel);
    if (!coords) {
        return { ...hotel, coordinates: null };
    }

    const propertyInfo = hotel.propertyInfo
        ? {
              ...hotel.propertyInfo,
              latitude: hotel.propertyInfo.latitude ?? String(coords.latitude),
              longitude: hotel.propertyInfo.longitude ?? String(coords.longitude),
          }
        : hotel.propertyInfo;

    return {
        ...hotel,
        propertyInfo,
        coordinates: coords,
        latitude: coords.latitude,
        longitude: coords.longitude,
    };
}
