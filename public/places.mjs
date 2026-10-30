/**
 * The places My day's weather can be for: Philippine cities, Manila first, with their coordinates (all Felix sends
 * the weather service). Shared by the weather reader (myday.mjs) and Settings, so the menu and the map agree.
 */

/** The places the weather can be for: Philippine cities, Manila first. */
export const PLACES = Object.freeze([
  { id: "manila", name: "Manila", lat: 14.5995, lon: 120.9842 },
  { id: "quezon-city", name: "Quezon City", lat: 14.676, lon: 121.0437 },
  { id: "makati", name: "Makati", lat: 14.5547, lon: 121.0244 },
  { id: "pasig", name: "Pasig", lat: 14.5764, lon: 121.0851 },
  { id: "taguig", name: "Taguig", lat: 14.5176, lon: 121.0509 },
  { id: "antipolo", name: "Antipolo", lat: 14.6255, lon: 121.1245 },
  { id: "tagaytay", name: "Tagaytay", lat: 14.1153, lon: 120.9621 },
  { id: "baguio", name: "Baguio", lat: 16.4023, lon: 120.596 },
  { id: "angeles", name: "Angeles", lat: 15.145, lon: 120.5887 },
  { id: "batangas", name: "Batangas", lat: 13.7565, lon: 121.0583 },
  { id: "iloilo", name: "Iloilo", lat: 10.7202, lon: 122.5621 },
  { id: "bacolod", name: "Bacolod", lat: 10.6765, lon: 122.9509 },
  { id: "cebu", name: "Cebu", lat: 10.3157, lon: 123.8854 },
  { id: "cagayan-de-oro", name: "Cagayan de Oro", lat: 8.4542, lon: 124.6319 },
  { id: "davao", name: "Davao", lat: 7.1907, lon: 125.4553 },
]);
