/**
 * Master listing stores IATA-style country labels.
 * Provesio /hotel/search only accepts a plain country name
 * (VAL-004: "Invalid country name (Example: India)").
 */

const ISO2_TO_PROVESIO = {
  HK: "Hong Kong",
  MO: "Macau",
  KR: "South Korea",
  KP: "North Korea",
  AE: "United Arab Emirates",
  TW: "Taiwan",
  CN: "China",
  IN: "India",
  GB: "United Kingdom",
  US: "United States",
  VN: "Vietnam",
  RU: "Russia",
  BN: "Brunei",
  BA: "Bosnia and Herzegovina",
  CI: "Ivory Coast",
  LA: "Laos",
  LY: "Libya",
  MD: "Moldova",
  MS: "Montserrat",
  MK: "Macedonia",
  RS: "Serbia",
  RE: "Réunion",
  SY: "Syria",
  TZ: "Tanzania",
  WF: "Wallis and Futuna",
  LC: "Saint Lucia",
  PM: "Saint Pierre and Miquelon",
  VC: "Saint Vincent and the Grenadines",
  KN: "Saint Kitts and Nevis",
  VI: "United States Virgin Islands",
  VG: "British Virgin Islands",
  CD: "Democratic Republic of the Congo",
};

const LISTING_COUNTRY_TO_PROVESIO = {
  "hong kong, (sar) china": "Hong Kong",
  "macao, (sar) china": "Macau",
  "korea, republic of": "South Korea",
  "republic of korea": "South Korea",
  "korea, democratic peoples republic of": "North Korea",
  "st. christopher (st. kitts) nevis": "Saint Kitts and Nevis",
  "virgin islands, united states": "United States Virgin Islands",
  uae: "United Arab Emirates",
  "bosnia herzegovina": "Bosnia and Herzegovina",
  "brunei darussalam": "Brunei",
  "chinese taipei": "Taiwan",
  "cote d'ivoire": "Ivory Coast",
  "lao peoples democratic republic": "Laos",
  "libyan arab jamahiriya": "Libya",
  moldovo: "Moldova",
  monserrat: "Montserrat",
  "republic of macedonia": "Macedonia",
  "republic of serbia": "Serbia",
  reunion: "Réunion",
  "russian federation": "Russia",
  "syrian arab republic": "Syria",
  "united republic of tanzania": "Tanzania",
  "viet nam": "Vietnam",
  "wallis and futuna islands": "Wallis and Futuna",
  "st. lucia": "Saint Lucia",
  "st. pierre and miquelon": "Saint Pierre and Miquelon",
  "st. vincent and the grenadines": "Saint Vincent and the Grenadines",
  "democratic republic of the congo": "Democratic Republic of the Congo",
  "british virgin islands": "British Virgin Islands",
};

function lookupAlias(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return null;
  return LISTING_COUNTRY_TO_PROVESIO[key] || null;
}

export function toProvesioHotelCountry(country, countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code) && ISO2_TO_PROVESIO[code]) {
    return ISO2_TO_PROVESIO[code];
  }

  const raw = String(country || "").trim();
  if (!raw) return raw;

  const aliased = lookupAlias(raw);
  if (aliased) return aliased;

  const commaParen = raw.match(/^([^,]+),\s*\(/);
  if (commaParen && commaParen[1]) {
    const head = commaParen[1].trim();
    return lookupAlias(head) || head;
  }

  return raw;
}
