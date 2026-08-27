const parseMaybeJson = (value) => {
  if (value == null || value === "") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const firstNonEmpty = (...candidates) => {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = typeof candidate === "string" ? candidate.trim() : candidate;
    if (value !== "" && value !== undefined && value !== null) return typeof value === "string" ? value : candidate;
  }
  return "";
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const guestFullName = (passenger) => {
  const info = passenger?.passengerInfo || {};
  return [info.nameTitle, info.givenName, info.surname]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
};

const facilityName = (facility) => {
  if (typeof facility === "string") return facility.trim();
  return firstNonEmpty(facility?.name, facility?.description, facility?.facilityName);
};

const imageUrl = (img) => {
  if (!img) return "";
  if (typeof img === "string") return /^https?:\/\//i.test(img) ? img.trim() : "";
  const url = firstNonEmpty(img.path, img.url, img.imageUrl);
  return /^https?:\/\//i.test(url) ? url : "";
};

const formatStayDate = (raw) => {
  if (!raw) return "";
  const text = String(raw);
  const date = new Date(text.includes("T") ? text : `${text.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const nightsBetween = (checkIn, checkOut) => {
  if (!checkIn || !checkOut) return 0;
  const start = new Date(String(checkIn).includes("T") ? checkIn : `${String(checkIn).slice(0, 10)}T12:00:00`);
  const end = new Date(String(checkOut).includes("T") ? checkOut : `${String(checkOut).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  return nights > 0 ? nights : 0;
};

const formatClock = (hhmm) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!match) return "";
  let hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${String(hours).padStart(2, "0")}:${minutes} ${suffix}`;
};

const extractTimeFromNotes = (notes, kind) => {
  const text = String(notes || "").replace(/<[^>]+>/g, " ");
  const patterns =
    kind === "checkIn"
      ? [/Check-in hour\s*:?\s*-?([0-9]{1,2}:[0-9]{2})/i, /Check-in\s*(?:from|at)\s*:?\s*-?([0-9]{1,2}:[0-9]{2})/i]
      : [/Check-out hour\s*:?\s*-?([0-9]{1,2}:[0-9]{2})/i, /Check-out\s*(?:until|at)\s*:?\s*-?([0-9]{1,2}:[0-9]{2})/i];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return formatClock(match[1]);
  }
  return "";
};

const mergeRooms = (primaryRooms, fallbackRooms) => {
  const fallbackByKey = new Map();
  fallbackRooms.forEach((room, index) => {
    const key = room?.roomKey || room?.roomIndex || index;
    fallbackByKey.set(String(key), room);
  });

  if (!primaryRooms.length) return fallbackRooms;

  return primaryRooms.map((room, index) => {
    const fallback =
      fallbackByKey.get(String(room?.roomKey)) ||
      fallbackByKey.get(String(room?.roomIndex)) ||
      fallbackRooms[index] ||
      {};
    const primaryTaxes = asArray(room?.roomRate?.taxes);
    const fallbackTaxes = asArray(fallback?.roomRate?.taxes);
    const primaryFacilities = asArray(room?.roomFacilities);
    const fallbackFacilities = asArray(fallback?.roomFacilities);

    return {
      ...fallback,
      ...room,
      ratePlan: { ...(fallback.ratePlan || {}), ...(room.ratePlan || {}) },
      roomRate: {
        ...(fallback.roomRate || {}),
        ...(room.roomRate || {}),
        taxes: primaryTaxes.length ? primaryTaxes : fallbackTaxes,
      },
      roomFacilities: primaryFacilities.length ? primaryFacilities : fallbackFacilities,
      rateNotes: room?.rateNotes || fallback?.rateNotes,
    };
  });
};

const passengersForRoom = (passengers, room, index) => {
  const roomIndex = Number(room?.roomIndex) || index + 1;
  const matched = passengers.filter(
    (passenger) => passenger?.roomIndex != null && passenger.roomIndex !== "" && Number(passenger.roomIndex) === roomIndex
  );
  if (index === 0) {
    const loose = passengers.filter((passenger) => passenger?.roomIndex == null || passenger.roomIndex === "");
    return [...matched, ...loose];
  }
  return matched;
};

const formatMeal = (meal) => {
  const value = String(meal || "").trim();
  if (!value) return "";
  if (/room\s*only|no\s*meal/i.test(value)) return "No Meals Included";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const houseRuleText = (rule) => {
  if (!rule) return "";
  if (typeof rule === "string") return rule.trim();
  return firstNonEmpty(rule.text, rule.description, rule.label, rule.name);
};

const contactEmailFromPassengers = (passengers) => {
  for (const passenger of passengers) {
    const contacts = asArray(passenger?.contact?.contactsProvided);
    for (const contact of contacts) {
      const email = asArray(contact?.emailAddress)[0];
      if (email) return String(email).trim();
    }
  }
  return "";
};

export const resolveHotelBookSearchKey = (record = {}) => {
  const request = parseMaybeJson(record.request) || {};
  return firstNonEmpty(record.searchKey, request.searchKey);
};

export const resolveHotelBookBookingKey = (record = {}) => {
  const request = parseMaybeJson(record.request) || {};
  return firstNonEmpty(record.bookingKey, request.bookingKey);
};

export const buildHotelEmailPayload = ({
  booking = {},
  storedBook = {},
  preBook = {},
  hotelDetail = {},
  userDetails = {},
} = {}) => {
  const request = parseMaybeJson(storedBook.request) || parseMaybeJson(booking.request) || {};
  const storedHotel = parseMaybeJson(storedBook.hotel) || {};
  const preBookHotel = parseMaybeJson(preBook.hotel) || {};
  const verified =
    parseMaybeJson(preBook.verifiedPropertyInfo) ||
    storedHotel.verifiedPropertyInfo ||
    booking.hotel?.verifiedPropertyInfo ||
    {};

  const hotel = {
    ...(preBookHotel || {}),
    ...(storedHotel || {}),
    ...(booking.hotel || {}),
  };

  const detailHotel = asArray(hotelDetail?.data)[0] || hotelDetail || {};
  const passengers = asArray(
    booking.passengers ||
      booking.hotel?.passengers ||
      parseMaybeJson(storedBook.passengers) ||
      parseMaybeJson(preBook.passengers)
  );

  const mergedRooms = mergeRooms(
    asArray(hotel.rooms),
    asArray(parseMaybeJson(preBook.rooms) || preBookHotel.rooms)
  );

  const checkInDate = firstNonEmpty(hotel.checkInDate, hotel.checkIn, request.stayDateRange?.checkIn);
  const checkOutDate = firstNonEmpty(hotel.checkOutDate, hotel.checkOut, request.stayDateRange?.checkOut);
  const nightCount = nightsBetween(checkInDate, checkOutDate);
  const roomCount = mergedRooms.length || asArray(request.rooms).length || 1;

  const rateNotes = mergedRooms.map((room) => room?.rateNotes).filter(Boolean).join(" ");
  const checkInClock = firstNonEmpty(
    extractTimeFromNotes(rateNotes, "checkIn"),
    formatClock(verified.checkInTime || verified.checkInFrom || hotel.checkInTime || detailHotel.checkInTime)
  );
  const checkOutClock = firstNonEmpty(
    extractTimeFromNotes(rateNotes, "checkOut"),
    formatClock(verified.checkOutTime || verified.checkOutUntil || hotel.checkOutTime || detailHotel.checkOutTime)
  );

  const rooms = mergedRooms.map((room, index) => {
    const roomGuests = passengersForRoom(passengers, room, index);
    const amenities = asArray(room.roomFacilities)
      .map(facilityName)
      .filter(Boolean);
    const visibleAmenities = amenities.slice(0, 5);

    return {
      roomType: firstNonEmpty(room.roomTypeName, room.roomType, room.name, `Room ${index + 1}`),
      amenities: visibleAmenities,
      amenitiesExtraCount: Math.max(0, amenities.length - visibleAmenities.length),
      guestName: guestFullName(roomGuests[0]) || guestFullName(passengers[0]),
      mealPlan: formatMeal(room?.ratePlan?.meal),
    };
  });

  const taxes = mergedRooms.flatMap((room) => asArray(room?.roomRate?.taxes));
  const taxTotal = taxes.reduce((sum, tax) => sum + (Number(tax?.amount) || 0), 0);
  const vatTotal = taxes
    .filter((tax) => /vat/i.test(String(tax?.name || tax?.taxCode || "")))
    .reduce((sum, tax) => sum + (Number(tax?.amount) || 0), 0);
  const currency = firstNonEmpty(hotel.currency, request.currency, storedBook.currency, "AED");
  const totalFare = Number(hotel.totalNet ?? request.totalNet);
  const propertyCharges = Number.isFinite(totalFare) && taxTotal > 0 ? totalFare - taxTotal : undefined;

  const cancelIndicators = mergedRooms
    .map((room) => firstNonEmpty(room?.ratePlan?.cancelPolicyIndicator, room?.ratePlan?.cancellationPolicy))
    .filter(Boolean);
  const lastCancelDate = firstNonEmpty(
    ...mergedRooms.map((room) => room?.ratePlan?.lastCancellationDate),
    hotel.lastCancellationDate
  );
  const isNonRefundable = cancelIndicators.some((value) => /non[-\s]?refundable/i.test(value));
  const cancellationHeadline = isNonRefundable
    ? "Non-refundable"
    : lastCancelDate
      ? `Free Cancellation till ${formatStayDate(lastCancelDate)}`
      : firstNonEmpty(...cancelIndicators);

  const propertyPolicies = asArray(preBook.houseRules || hotel.houseRules || verified.houseRules)
    .map(houseRuleText)
    .filter(Boolean);

  const address = [
    firstNonEmpty(verified.address, hotel.address, detailHotel.address),
    firstNonEmpty(verified.city, hotel.city, detailHotel.city),
    firstNonEmpty(verified.country, hotel.country, detailHotel.country),
  ]
    .filter(Boolean)
    .filter((part, index, list) => list.indexOf(part) === index)
    .join(", ");

  const imageCandidates = [
    ...asArray(hotel.images),
    ...asArray(hotel.hotelImages),
    ...asArray(detailHotel.images),
    verified.imageUrl,
  ];
  const image = imageCandidates.map(imageUrl).find(Boolean) || "";

  const starRating = Number(
    firstNonEmpty(detailHotel.starRating, detailHotel?.propertyInfo?.starRating, hotel.starRating, hotel.rating, verified.starRating)
  );

  const leadEmail = contactEmailFromPassengers(passengers);
  const requestEmail = firstNonEmpty(
    request.customerInfo?.emailAddress,
    asArray(request.customerInfo?.emailAddress)[0]
  );

  return {
    email: firstNonEmpty(userDetails.email, leadEmail, requestEmail),
    username: firstNonEmpty(userDetails.name, guestFullName(passengers[0]), "Guest"),
    bookingReferenceId: firstNonEmpty(booking.bookingReferenceId, storedBook.bookingReferenceId),
    confirmationNo: firstNonEmpty(booking.supplierReferenceId, storedBook.supplierReferenceId),
    hotelDetail: {
      hotelName: firstNonEmpty(hotel.name, detailHotel.name),
      starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : "",
      image,
      address,
      phone: firstNonEmpty(detailHotel.phone, detailHotel?.propertyInfo?.phone, hotel.phone, verified.phone),
      hotelEmail: firstNonEmpty(detailHotel.email, detailHotel?.propertyInfo?.email, hotel.email, verified.email),
      checkInDate: formatStayDate(checkInDate),
      checkInTime: checkInClock ? `After ${checkInClock}` : "",
      checkOutDate: formatStayDate(checkOutDate),
      checkOutTime: checkOutClock ? `Before ${checkOutClock}` : "",
      roomCount,
      nightCount,
    },
    rooms,
    price: {
      currency,
      propertyCharges: Number.isFinite(propertyCharges) && propertyCharges > 0 ? propertyCharges : "",
      taxes: taxTotal > 0 ? taxTotal : "",
      vat: vatTotal > 0 ? vatTotal : "",
      serviceFee: "",
      totalFare: Number.isFinite(totalFare) ? totalFare : "",
    },
    cancellation: {
      headline: cancellationHeadline,
      rules: [],
    },
    importantNotices: [
      "For early check-in, extra bed and airport pickups contact the hotel directly",
      "Valid ID/Passport is required at the time of check-in.",
      "All guests must be registered at the hotel",
      "This voucher is valid only for the stay and dates mentioned above",
      "This voucher is non-transferrable and cannot be exchanged for cash",
      "Al Rais Travel acts only as an agent for the hotel and is not responsible for any loss, damage, or inconvenience during your stay.",
      "Any additional services or charges availed at the hotel will be payable directly by you at the hotel",
    ],
    propertyPolicies,
  };
};

export { parseMaybeJson };
