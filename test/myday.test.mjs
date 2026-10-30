import { test } from "node:test";
import assert from "node:assert/strict";
import { PH_HOLIDAYS, PLACES, createMyDay, isDayOff, parseWeather, skyOf, toHolidays, weatherUrl } from "../myday.mjs";

process.env.TZ = "Asia/Manila";

// 7:45 PM Friday 30 October 2026 in Manila.
const NOW = Date.parse("2026-10-30T11:45:00Z");

/** Open-Meteo's answer for two days, shaped as its docs show, with made-up readings. */
function fixture() {
  const time = [];
  const temperature_2m = [];
  const weather_code = [];
  const precipitation_probability = [];
  for (const day of ["2026-10-30", "2026-10-31"]) {
    for (let h = 0; h < 24; h++) {
      time.push(`${day}T${String(h).padStart(2, "0")}:00`);
      temperature_2m.push(25 + (h >= 10 && h <= 15 ? 6 : 2) + (day === "2026-10-31" ? 0.5 : 0));
      weather_code.push(h === 21 ? 95 : h >= 18 ? 61 : 2);
      precipitation_probability.push(h >= 18 ? 70 : 10);
    }
  }
  return {
    latitude: 14.6, longitude: 121, timezone: "Asia/Manila",
    current: { time: "2026-10-30T19:45", interval: 900, temperature_2m: 28.4, apparent_temperature: 32.1, weather_code: 3, is_day: 0 },
    hourly: { time, temperature_2m, weather_code, precipitation_probability },
    daily: { time: ["2026-10-30", "2026-10-31"], temperature_2m_max: [31.2, 31.7], temperature_2m_min: [25.1, 24.9], weather_code: [61, 2], precipitation_probability_max: [70, 20] },
  };
}

test("the sky in plain words from the weather code", () => {
  assert.deepEqual([0, 1, 2, 3, 45, 53, 63, 81, 95, 99, 42].map(skyOf),
    ["Clear", "Mostly clear", "Partly cloudy", "Cloudy", "Foggy", "Drizzle", "Rain", "Showers", "Thunderstorms", "Thunderstorms", "Unknown"]);
});

test("the weather address carries the place, Manila's time zone and only what the card shows", () => {
  const u = new URL(weatherUrl(PLACES[0]));
  assert.equal(u.origin + u.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.deepEqual([u.searchParams.get("latitude"), u.searchParams.get("longitude"), u.searchParams.get("timezone")], ["14.5995", "120.9842", "Asia/Manila"]);
  assert.match(u.searchParams.get("current"), /temperature_2m/);
  assert.equal(PLACES[0].name, "Manila");
  assert.equal(new Set(PLACES.map((p) => p.id)).size, PLACES.length);
});

test("parseWeather reads now, today's high and low, and the hours after now", () => {
  const w = parseWeather(fixture());
  assert.deepEqual(w.now, { time: "2026-10-30T19:45", temp: 28.4, feels: 32.1, sky: "Cloudy", code: 3, day: false });
  assert.deepEqual(w.today, { high: 31.2, low: 25.1, sky: "Rain", rain: 70 });
  assert.equal(w.hours[0].time, "2026-10-30T20:00", "the next full hour after 7:45");
  assert.deepEqual(w.hours[1], { time: "2026-10-30T21:00", temp: 27, code: 95, rain: 70, sky: "Thunderstorms" });
  assert.equal(w.hours.length, 28, "to the end of tomorrow");
});

test("parseWeather turns down an answer it can't use, and tolerates missing extras", () => {
  assert.throws(() => parseWeather({}), /can't read/);
  assert.throws(() => parseWeather({ current: { temperature_2m: "hot" }, hourly: { time: [] }, daily: { time: ["x"] } }), /can't read/);
  const f = fixture();
  delete f.current.apparent_temperature;
  delete f.daily.precipitation_probability_max;
  const w = parseWeather(f);
  assert.deepEqual([w.now.feels, w.today.rain], [null, null]);
});

test("holidays from the public calendar: one per day, observances marked by Google's own words", () => {
  const items = [
    { summary: "All Saints' Day", description: "Public holiday", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
    { summary: "Christmas break", description: "Special non-working holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-26" } },
    { summary: "Valentine's Day", description: "Observance\nTo hide observances, go to Google Calendar Settings", start: { date: "2027-02-14" }, end: { date: "2027-02-15" } },
    { summary: "Gone", status: "cancelled", start: { date: "2026-11-05" } },
    { summary: "Timed", start: { dateTime: "2026-11-06T10:00:00+08:00" } },
  ];
  const list = toHolidays(items);
  assert.deepEqual(list.map((h) => h.day), ["2026-11-01", "2026-12-24", "2026-12-25", "2027-02-14"]);
  assert.deepEqual(list.map(isDayOff), [true, true, true, false]);
});

/**
 * My day's reader with fakes: the weather service, the calendar source, Google and the tracker.
 * @param {{ calendar?: Function, personal?: { client: boolean, connected: boolean }, google?: Function, weather?: Function }} [o]
 */
function setup(o = {}) {
  const fetches = [];
  const clock = { t: NOW };
  const day = createMyDay({
    now: () => clock.t,
    fetchImpl: async (url) => { fetches.push(url); return o.weather ? o.weather() : { ok: true, status: 200, json: async () => fixture() }; },
    calendarSource: { get: o.calendar || (async () => ({ items: [{ summary: "All Saints' Day", description: "Public holiday", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }] })) },
    google: {
      status: async () => o.personal || { client: false, connected: false },
      get: o.google || (async () => ({ items: [] })),
    },
    ooo: { out: async () => ({ out: [{ name: "PH Holiday", kind: "Holiday", from: "2026-11-02", to: "2026-11-02", holiday: true }, { name: "US Pure Holiday", kind: "Holiday", from: "2026-11-26", to: "2026-11-26", holiday: true }] }) },
  });
  return { day, fetches, clock };
}

test("the view has the weather, the next holiday and where the personal calendar stands", async () => {
  const { day, fetches } = setup();
  const v = await day.view({ place: "cebu" });
  assert.equal(v.today, "2026-10-30");
  assert.equal(v.weather.place, "Cebu");
  assert.match(fetches[0], /latitude=10\.3157/);
  assert.equal(v.weatherError, "");
  assert.deepEqual([v.holidays.today, v.holidays.next.name, v.holidays.source], [[], "All Saints' Day", "google"]);
  assert.deepEqual(v.calendar, { client: false, connected: false });
  // The weather is kept for a while; fresh asks again.
  await day.view({ place: "cebu" });
  assert.equal(fetches.length, 1);
  await day.view({ place: "cebu", fresh: true });
  assert.equal(fetches.length, 2);
  // An unknown place is Manila.
  assert.equal((await day.view({ place: "atlantis" })).weather.place, "Manila");
});

test("a weather failure is one plain line, and the rest still shows", async () => {
  const { day } = setup({ weather: () => { throw new Error("offline"); } });
  const v = await day.view({ place: "manila" });
  assert.deepEqual([v.weather, v.weatherError], [null, "Couldn't reach the weather service."]);
  assert.equal(v.holidays.next.name, "All Saints' Day");
  const { day: busy } = setup({ weather: () => ({ ok: false, status: 503 }) });
  assert.equal((await busy.view({ place: "manila" })).weatherError, "The weather service answered 503.");
});

test("an unreachable try is tried again, and a failed refresh keeps the last weather, marked as older", async () => {
  let calls = 0;
  let down = false;
  const { day, fetches } = setup({ weather: () => {
    calls += 1;
    if (down || calls === 1) throw new Error("connect timeout");
    return { ok: true, status: 200, json: async () => fixture() };
  } });
  const first = await day.view({ place: "manila" });
  assert.equal(fetches.length, 2, "the first try failed, the second answered");
  assert.equal(first.weather.place, "Manila");
  assert.equal(first.weather.stale, undefined);
  down = true;
  const later = await day.view({ place: "manila", fresh: true });
  assert.equal(fetches.length, 5, "three tries, then the last weather");
  assert.deepEqual([later.weather.place, later.weather.stale, later.weatherError], ["Manila", true, ""]);
});

test("an older bridge can't read the holiday calendar: the tracker's PH days stand in, with how to get names", async () => {
  const refused = async () => { throw Object.assign(new Error("The bridge only reads your calendar and the vacation tracker."), { code: "forbidden" }); };
  const { day } = setup({ calendar: refused });
  const v = await day.view({ place: "manila" });
  assert.equal(v.holidays.source, "tracker");
  assert.deepEqual(v.holidays.next, { day: "2026-11-02", name: "", kind: "" }, "only the PH day, not the US one");
  assert.match(v.holidays.note, /deploy a new version/);
  // With the personal account signed in, it reads the holidays (with names) through that instead.
  const seen = [];
  const { day: viaPersonal } = setup({ calendar: refused, personal: { client: true, connected: true },
    google: async (id, url) => { seen.push([id, decodeURIComponent(url)]); return { items: url.includes("holiday") ? [{ summary: "All Souls' Day", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } }] : [] }; } });
  const p = await viaPersonal.view({ place: "manila" });
  assert.deepEqual([p.holidays.source, p.holidays.next.name], ["google", "All Souls' Day"]);
  assert.ok(seen.some(([id, url]) => id === "personal" && url.includes(PH_HOLIDAYS)));
});

test("with the personal account signed in, today's events come from it", async () => {
  const { day } = setup({ personal: { client: true, connected: true }, google: async (id, url) => ({
    items: url.includes("primary") ? [{ id: "e1", summary: "Dinner with Mama", start: { dateTime: "2026-10-30T19:00:00+08:00" }, end: { dateTime: "2026-10-30T21:00:00+08:00" } }] : [],
  }) });
  const v = await day.view({ place: "manila" });
  assert.deepEqual([v.calendar.connected, v.calendar.events.map((e) => e.title)], [true, ["Dinner with Mama"]]);
  const { day: broken } = setup({ personal: { client: true, connected: true }, google: async () => { throw new Error("Google's sign-in expired. Sign in again."); } });
  const b = await broken.view({ place: "manila" });
  assert.equal(b.calendar.error, "Google's sign-in expired. Sign in again.");
});

test("holiday names for My time off leave out observances", async () => {
  const { day } = setup({ calendar: async () => ({ items: [
    { summary: "Bonifacio Day", description: "Public holiday", start: { date: "2026-11-30" }, end: { date: "2026-12-01" } },
    { summary: "Valentine's Day", description: "Observance", start: { date: "2027-02-14" }, end: { date: "2027-02-15" } },
  ] }) });
  assert.deepEqual([...(await day.holidayNames("2026-01-01", "2027-04-28"))], [["2026-11-30", "Bonifacio Day"]]);
});
