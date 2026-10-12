// Pure logic for the Launchpad (SpaceX) plugin. Qt-free so it stays testable
// under node: functions and `var` only, no arrow functions, no optional
// chaining. Data comes from Launch Library 2 (thespacedevs), which needs no
// key and returns the next SpaceX launches already sorted by NET.
//
// The one idea that matters here is planNotifications(): given the freshly
// fetched launches and the previously persisted state, it decides which
// notifications are owed and returns the next state. It never sends anything,
// which is what makes the scrub/reschedule logic testable.

var API_BASE = "https://ll.thespacedevs.com/2.2.0";

// Keep the request small: with SpaceX launching roughly weekly this covers
// well over a month, which is the whole horizon we ever notify about.
var UPCOMING_LIMIT = 8;

var USER_AGENT = "omarchy-launchpad/1.0 (+quickshell)";

// Notification thresholds, coarse to fine. `key` doubles as the persisted
// "already told the user" flag.
var TIERS = [
  { key: "t24", ms: 24 * 60 * 60 * 1000 },
  { key: "t1", ms: 60 * 60 * 1000 },
  { key: "t10", ms: 10 * 60 * 1000 }
];

// A launch that has slipped by more than this is over; stop counting it.
var LIFTOFF_GRACE_MS = 12 * 60 * 60 * 1000;

// A reschedule smaller than this is noise (LL2 nudges NET by seconds as
// tracking data firms up); bigger than this means a genuinely new attempt.
var RESCHEDULE_EPSILON_MS = 5 * 60 * 1000;

// Scene stages, keyed to time-to-zero. Deliberately coarse: the visual change
// should read as anticipation, not as a spec sheet. The countdown itself (not
// any telemetry we do not have) is what drives the whole scene.
var STAGE_IDLE_MS = 24 * 60 * 60 * 1000; // calmer-than-days-out
var STAGE_FINAL_MS = 10 * 60 * 1000;     // the last ten minutes
var STAGE_LIFTOFF_MS = 3 * 60 * 1000;    // how long the finale plays after T-0

// LL2 gives no timezone on a pad, only a name. These are the pads SpaceX
// actually launches from, matched by substring, most specific first.
var PAD_TIMEZONES = [
  { match: "starbase", tz: "America/Chicago" },
  { match: "orbital launch", tz: "America/Chicago" },
  { match: "suborbital", tz: "America/Chicago" },
  { match: "4e", tz: "America/Los_Angeles" },
  { match: "vandenberg", tz: "America/Los_Angeles" },
  { match: "39a", tz: "America/New_York" },
  { match: "39b", tz: "America/New_York" },
  { match: "40", tz: "America/New_York" },
  { match: "37", tz: "America/New_York" },
  { match: "kennedy", tz: "America/New_York" },
  { match: "cape canaveral", tz: "America/New_York" }
];

var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The three launch zones, with their US DST rules. Quickshell's JS engine has
// no Intl, so an IANA name cannot be resolved the usual way; these three
// zones all follow the modern US rule (second Sunday in March to the first
// Sunday in November), which is exact for any date after 2007.
var US_ZONES = {
  "America/Los_Angeles": { std: -8, dst: -7, stdName: "PST", dstName: "PDT" },
  "America/New_York": { std: -5, dst: -4, stdName: "EST", dstName: "EDT" },
  "America/Chicago": { std: -6, dst: -5, stdName: "CST", dstName: "CDT" }
};

var HOUR = 60 * 60 * 1000;

// Day-of-month of the nth given weekday in a month (weekday: 0 = Sunday).
function nthWeekday(year, month, weekday, nth) {
  var first = new Date(Date.UTC(year, month, 1));
  var lead = (weekday - first.getUTCDay() + 7) % 7;
  return 1 + lead + (nth - 1) * 7;
}

// Local wall-clock time in a zone, as a UTC instant, for the DST boundaries.
function zonedUtcMs(year, month, day, hour, offsetMs) {
  return Date.UTC(year, month, day, hour) - offsetMs;
}

// True when US daylight time applies at this instant in this zone.
function isZoneDst(ms, tz) {
  var zone = US_ZONES[tz];
  if (!zone) return false;
  var year = new Date(Number(ms)).getUTCFullYear();
  var start = zonedUtcMs(year, 2, nthWeekday(year, 2, 0, 2), 2, zone.std * HOUR);
  var end = zonedUtcMs(year, 10, nthWeekday(year, 10, 0, 1), 2, zone.dst * HOUR);
  return Number(ms) >= start && Number(ms) < end;
}

// Offset from UTC in hours for a zone at an instant, or NaN if unknown.
function zoneOffsetHours(ms, tz) {
  var zone = US_ZONES[tz];
  if (!zone || !isFinite(Number(ms))) return NaN;
  return isZoneDst(ms, tz) ? zone.dst : zone.std;
}

function pad2(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  return (n < 10 ? "0" : "") + n;
}

function upcomingUrl(limit) {
  var n = Number(limit) > 0 ? Math.floor(Number(limit)) : UPCOMING_LIMIT;
  return API_BASE + "/launch/upcoming/?limit=" + n
    + "&mode=detailed&lsp__name=SpaceX&ordering=net";
}

// --- parsing ---------------------------------------------------------------

function firstString() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && isFinite(v)) return String(v);
  }
  return "";
}

// An image is a plain URL in list mode but an object in detailed mode.
function imageUrl(image) {
  if (!image) return "";
  if (typeof image === "string") return image;
  return firstString(image.image_url, image.thumbnail_url, image.large);
}

// Prefer SpaceX's own broadcast; fall back to the best unofficial webcast.
function bestWebcast(vids) {
  if (!vids || !vids.length) return { url: "", label: "" };
  var official = null;
  var webcast = null;
  var any = null;
  for (var i = 0; i < vids.length; i++) {
    var v = vids[i] || {};
    var url = String(v.url || "");
    if (url === "") continue;
    if (!any) any = v;
    var typeName = (v.type && v.type.name) ? String(v.type.name) : "";
    if (official === null && typeName.indexOf("Official") === 0) official = v;
    else if (webcast === null && typeName.indexOf("Webcast") !== -1) webcast = v;
  }
  var pick = official || webcast || any;
  if (!pick) return { url: "", label: "" };
  return {
    url: String(pick.url || ""),
    label: (pick.type && pick.type.name) ? String(pick.type.name) : "Webcast"
  };
}

// Best mission-patch image: highest-priority entry wins, falling back to the
// generic launch image. Both are remote; the UI hides the badge on error.
function bestPatch(launch) {
  var arr = launch.mission_patches;
  if (arr && arr.length) {
    var best = null;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i] || {};
      if (!p.image_url) continue;
      if (!best || Number(p.priority || 0) > Number(best.priority || 0)) best = p;
    }
    if (best) return String(best.image_url);
  }
  return imageUrl(launch.image);
}

// Vehicle flight heritage, straight from the rocket configuration's own
// counters: flown = successes + failures. Displayed as "637 FLOWN" — a
// count of what flew, never a claim about which number this flight is.
function vehicleFlown(launch) {
  var rocket = launch.rocket || {};
  var cfg = rocket.configuration || {};
  var ok = Number(cfg.successful_launches);
  var bad = Number(cfg.failed_launches);
  if (!isFinite(ok) || !isFinite(bad) || ok < 0 || bad < 0) return NaN;
  return ok + bad;
}

// One-line heritage label for the panel. "" when the API gives no counters.
function flightLine(rec) {
  if (!rec) return "";
  var f = Number(rec.flightsFlown);
  if (!isFinite(f) || f < 0) return "";
  var v = String(rec.vehicle || "");
  return (v !== "" ? v.toUpperCase() + " · " : "") + f + " FLOWN";
}

// Routine Starlink batches are deliberately boring; crew, Starship and Falcon
// Heavy are the ones worth a louder glyph and a "critical" notification.
function classifyMission(mission, vehicle) {
  var m = String(mission || "").toLowerCase();
  var v = String(vehicle || "").toLowerCase();
  var isCargo = /crs|cargo|ng-\d|cygnus/.test(m);
  var crew = !isCargo && /crew-\d|polaris|axiom|ax-\d|fram\d|inspiration/.test(m);
  var starship = /starship/.test(v) || /starship|super ?heavy/.test(m);
  var heavy = /falcon heavy/.test(v) || /falcon heavy/.test(m);
  var starlink = /starlink/.test(m);
  return {
    crew: crew,
    starship: starship,
    heavy: heavy,
    starlink: starlink,
    noteworthy: crew || starship || heavy
  };
}

function parseNet(launch) {
  var ms = Date.parse(String(launch.net || ""));
  if (!isFinite(ms)) ms = Date.parse(String(launch.window_start || ""));
  return ms;
}

function normalizeLaunch(launch) {
  if (!launch || typeof launch !== "object") return null;
  var name = String(launch.name || "");
  var barIndex = name.indexOf("|");
  var vehicle = barIndex >= 0 ? name.slice(0, barIndex).trim() : "";
  var mission = barIndex >= 0 ? name.slice(barIndex + 1).trim() : name.trim();

  var status = launch.status || {};
  var pad = launch.pad || {};
  var location = pad.location || launch.location || {};
  var precision = (launch.net_precision && launch.net_precision.abbrev)
    ? String(launch.net_precision.abbrev) : "UNKNOWN";
  var netMs = parseNet(launch);
  var webcast = bestWebcast(launch.vidURLs);
  var missionType = (launch.mission && launch.mission.type) ? String(launch.mission.type) : "";
  var missionObj = launch.mission || {};
  var orbitObj = missionObj.orbit || {};
  var missionBlurb = (missionObj.description !== null && missionObj.description !== undefined)
    ? String(missionObj.description) : "";

  return {
    id: firstString(launch.id, launch.slug),
    slug: String(launch.slug || ""),
    url: String(launch.url || ""),
    name: name,
    vehicle: vehicle,
    mission: mission,
    missionType: missionType,
    netRaw: String(launch.net || ""),
    netMs: isFinite(netMs) ? netMs : NaN,
    windowStartMs: Date.parse(String(launch.window_start || "")),
    windowEndMs: Date.parse(String(launch.window_end || "")),
    netPrecision: precision,
    // Only second- and minute-precision launches get a live ticking countdown
    // and the ten-minute alert; a month placeholder has no meaningful T-0.
    precise: precision === "SEC" || precision === "MIN",
    statusAbbrev: String(status.abbrev || ""),
    statusName: String(status.name || ""),
    statusId: Number(status.id || 0),
    probability: (launch.probability === null || launch.probability === undefined)
      ? -1 : Number(launch.probability),
    padName: String(pad.name || ""),
    locationName: String(location.name || ""),
    // Pad coordinates feed the scene's day/night sky, so they are worth
    // keeping even though nothing else needs them.
    padLat: (pad.latitude === null || pad.latitude === undefined) ? NaN : Number(pad.latitude),
    padLng: (pad.longitude === null || pad.longitude === undefined) ? NaN : Number(pad.longitude),
    timezone: padTimezone(String(pad.name || "")),
    webcastUrl: webcast.url,
    webcastLabel: webcast.label,
    webcastLive: launch.webcast_live === true,
    imageUrl: imageUrl(launch.image),
    patchUrl: bestPatch(launch),
    missionBlurb: missionBlurb,
    orbit: String(orbitObj.abbrev || orbitObj.name || ""),
    flightsFlown: vehicleFlown(launch),
    flags: classifyMission(mission, vehicle)
  };
}

function parseUpcoming(raw) {
  var data = null;
  try { data = JSON.parse(String(raw || "")); } catch (e) { return []; }
  if (!data || !data.results || !data.results.length) return [];
  var out = [];
  for (var i = 0; i < data.results.length; i++) {
    var rec = normalizeLaunch(data.results[i]);
    if (rec && rec.id !== "" && isFinite(rec.netMs)) out.push(rec);
  }
  return out;
}

function padTimezone(padName) {
  var name = String(padName || "").toLowerCase();
  if (name === "") return "";
  for (var i = 0; i < PAD_TIMEZONES.length; i++) {
    if (name.indexOf(PAD_TIMEZONES[i].match) !== -1) return PAD_TIMEZONES[i].tz;
  }
  return "";
}

// --- launch scene -----------------------------------------------------------

// Named stage for the visual scene, purely from time-to-zero:
//
//   idle     more than a day out — ambient
//   approach inside a day — vapor, changing light
//   final    inside ten minutes — ring, ticks, go/no-go
//   liftoff  T-0 to three minutes later — plume, shake, then the stamp
//   stamp    after that — the tracked card rests
function stageFor(msToT0) {
  var t = Number(msToT0);
  if (!isFinite(t)) return "idle";
  if (t > STAGE_IDLE_MS) return "idle";
  if (t > STAGE_FINAL_MS) return "approach";
  if (t > 0) return "final";
  if (t > -STAGE_LIFTOFF_MS) return "liftoff";
  return "stamp";
}

// Sun elevation in degrees above the horizon, from a closed-form
// low-precision solar position (good to well under a degree, which is far
// more than a sky gradient needs). Doing the maths here instead of calling a
// sunset API keeps the scene offline, instant, and testable.
function sunElevationDeg(dateMs, latDeg, lngDeg) {
  // Number(null) and Number("") are both 0, which would silently pass as a
  // real coordinate; QML bindings hand these over all the time.
  if (dateMs === null || dateMs === undefined || dateMs === "") return NaN;
  if (latDeg === null || latDeg === undefined || latDeg === "") return NaN;
  if (lngDeg === null || lngDeg === undefined || lngDeg === "") return NaN;

  var ms = Number(dateMs);
  var lat = Number(latDeg);
  var lng = Number(lngDeg);
  if (!isFinite(ms) || !isFinite(lat) || !isFinite(lng)) return NaN;

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;
  var d = new Date(ms);
  var jd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 86400000 + 2440587.5;

  var n = jd - 2451545.0; // days since J2000
  var meanLon = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  var meanAnom = (357.528 + 0.9856003 * n) * RAD;
  var lam = (meanLon + 1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom)) * RAD;
  var obl = (23.439 - 0.0000004 * n) * RAD;

  var decl = Math.asin(Math.sin(obl) * Math.sin(lam));
  var rightAsc = Math.atan2(Math.cos(obl) * Math.sin(lam), Math.cos(lam));
  var gmstDeg = ((18.697374558 + 24.06570982441908 * n) % 24) * 15;
  var hourAngle = ((gmstDeg + lng) * RAD) - rightAsc;

  var latR = lat * RAD;
  var sinAlt = Math.sin(latR) * Math.sin(decl)
    + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

// Bucket the sun's height at the pad into the sky the scene paints. The
// thresholds sit on the familiar astronomical landmarks, so the sky at the pad
// at T-0 is genuinely the sky of that moment.
function skyPhaseFor(netMs, latDeg, lngDeg) {
  var elev = sunElevationDeg(netMs, latDeg, lngDeg);
  if (!isFinite(elev)) return "unknown";
  if (elev >= 6) return "day";
  if (elev >= -0.833) return "golden";
  if (elev >= -6) return "twilight";
  if (elev >= -12) return "dusk";
  if (elev >= -18) return "night";
  return "deep";
}

// 0–1 across the sky phases, for a smooth gradient instead of steps.
function skyPhaseValue(skyPhase) {
  var map = {
    deep: 0,
    night: 0.2,
    dusk: 0.38,
    twilight: 0.56,
    golden: 0.76,
    day: 1
  };
  return Object.prototype.hasOwnProperty.call(map, skyPhase) ? map[skyPhase] : 0.5;
}

// First launch that has not yet passed its grace window.
function pickNext(records, nowMs) {
  if (!records || !records.length) return null;
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (rec && isFinite(rec.netMs) && rec.netMs + LIFTOFF_GRACE_MS > nowMs) return rec;
  }
  return null;
}

// --- formatting ------------------------------------------------------------

function localClock(ms) {
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "--:--";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function localDayClock(ms) {
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "";
  return DAYS[d.getDay()] + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function localLong(ms) {
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "";
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " · "
    + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Time at the pad, which is the time that actually appears in a webcast
// title. Intl is guarded because the Qt QML engine's coverage varies; when it
// is unavailable the caller simply hides the pad-time row.
// Wall-clock string in a zone ("hh:mm"), from the UTC epoch maths above.
// Quickshell's JS engine ships no Intl, so an IANA name cannot be resolved by
// any library; the three zones we care about are handled exactly instead.
function formatInZone(ms, tz) {
  var off = zoneOffsetHours(ms, tz);
  if (!isFinite(off)) return "";
  var d = new Date(Number(ms) + off * HOUR);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

// Day-and-clock string in a zone ("Sat 00:39"), same rules.
function formatDayInZone(ms, tz) {
  var off = zoneOffsetHours(ms, tz);
  if (!isFinite(off)) return "";
  var d = new Date(Number(ms) + off * HOUR);
  return DAYS[d.getUTCDay()] + " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

// Zone abbreviation at an instant ("PDT"), because the clock alone is
// ambiguous an hour a year.
function tzAbbrev(ms, tz) {
  var zone = US_ZONES[tz];
  if (!zone || !isFinite(Number(ms))) return "";
  return isZoneDst(ms, tz) ? zone.dstName : zone.stdName;
}

// "T+" once the clock tips past zero, so a launch in progress reads correctly.
function formatClock(ms) {
  var neg = Number(ms) < 0;
  var a = Math.abs(Number(ms));
  var d = Math.floor(a / 86400000);
  var h = Math.floor((a % 86400000) / 3600000);
  var m = Math.floor((a % 3600000) / 60000);
  var s = Math.floor((a % 60000) / 1000);
  var core = (d > 0 ? d + "d " : "") + pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  return (neg ? "T+ " : "T- ") + core;
}

function formatDays(ms) {
  var a = Math.abs(Number(ms));
  var d = Math.floor(a / 86400000);
  var h = Math.floor((a % 86400000) / 3600000);
  var m = Math.floor((a % 3600000) / 60000);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return Math.max(1, m) + "m";
}

// Compact duration for window captions: "3H 05M", "42M".
function compactDur(ms) {
  var a = Math.max(0, Number(ms));
  var h = Math.floor(a / 3600000);
  var m = Math.floor((a % 3600000) / 60000);
  if (h > 0) return h + "H " + pad2(m) + "M";
  return Math.max(1, m) + "M";
}

// Window awareness for the panel caption. The precise T-0 stays the primary
// countdown; this says where the wall clock stands against the launch window.
// "" when the launch publishes no usable window.
function windowCaption(rec, nowMs) {
  if (!rec) return "";
  var ws = Number(rec.windowStartMs), we = Number(rec.windowEndMs);
  if (!isFinite(ws) || !isFinite(we) || we <= ws) return "";
  if (nowMs < ws) return "WINDOW OPENS IN " + compactDur(ws - nowMs);
  if (nowMs <= we) return "WINDOW CLOSES IN " + compactDur(we - nowMs);
  return "";
}

// Compact label for the bar. Only the last hour before liftoff shows a live
// timer (it appears exactly when the bar turns urgent); earlier than that the
// bar is the rocket icon alone. Coarse-precision launches never show a timer,
// because a live countdown on a month placeholder is a lie.
function formatBarCountdown(rec, nowMs) {
  if (!rec || !isFinite(rec.netMs)) return "";
  var remaining = rec.netMs - nowMs;
  if (remaining <= 0) return remaining > -LIFTOFF_GRACE_MS ? "LIVE" : "";
  if (!rec.precise) return "";
  if (remaining > 3600000) return "";
  return formatClock(remaining);
}

// Full-length countdown for the panel; null when there is no meaningful T-0.
function formatPanelCountdown(rec, nowMs) {
  if (!rec || !isFinite(rec.netMs) || !rec.precise) return "";
  var remaining = rec.netMs - nowMs;
  if (remaining <= 0 && remaining <= -LIFTOFF_GRACE_MS) return "";
  return formatClock(remaining);
}

// --- notification planning -------------------------------------------------

function shallowCopy(obj) {
  var out = {};
  for (var k in obj) if (obj.hasOwnProperty(k)) out[k] = obj[k];
  return out;
}

// Tiers already in the past when a launch is first seen are marked fired, so
// discovering a launch five minutes out does not replay a day's worth of
// alerts at once.
function firedAtFirstSight(remainingMs) {
  var fired = {};
  for (var i = 0; i < TIERS.length; i++) fired[TIERS[i].key] = remainingMs <= TIERS[i].ms;
  return fired;
}

function statusEventKind(toAbbrev) {
  var t = String(toAbbrev || "").toLowerCase();
  if (t.indexOf("scrub") !== -1) return "scrubbed";
  if (t.indexOf("hold") !== -1) return "hold";
  if (t.indexOf("in flight") !== -1) return "liftoff";
  if (t.indexOf("success") !== -1) return "success";
  if (t.indexOf("failure") !== -1) return "failure";
  if (t.indexOf("go") !== -1) return "go";
  return "status";
}

// Scene truth override from the launch's real lifecycle status. "hold"
// freezes the scene where the clock stood; "flight" forces ignition visuals
// when the vehicle is climbing but the published T-0 slipped. "" follows the
// live clock. Pure, so the scene's honesty about holds is unit-tested.
function sceneOverride(rec) {
  if (!rec) return "";
  var a = String(rec.statusAbbrev || "").toLowerCase();
  if (a.indexOf("hold") !== -1) return "hold";
  if (a.indexOf("in flight") !== -1 || a.indexOf("inflight") !== -1) return "flight";
  return "";
}

// Core of the plugin. Pure: (records, state, nowMs) -> (nextState, events).
// `events` is an ordered list of {kind, launch}; the caller turns each into a
// notification and writes nextState back to disk.
function planNotifications(records, state, nowMs) {
  var prevLaunches = (state && state.launches) ? state.launches : {};
  var nextLaunches = {};
  var events = [];

  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (!rec || rec.id === "" || !isFinite(rec.netMs)) continue;
    var remaining = rec.netMs - nowMs;
    if (remaining < -LIFTOFF_GRACE_MS) continue;

    var prev = prevLaunches[rec.id];
    var entry;

    if (!prev) {
      entry = {
        name: rec.name,
        net: rec.netRaw,
        status: rec.statusAbbrev,
        precision: rec.netPrecision,
        fired: firedAtFirstSight(remaining),
        lastSeen: nowMs
      };
      nextLaunches[rec.id] = entry;
      continue;
    }

    entry = {
      name: rec.name,
      net: rec.netRaw,
      status: rec.statusAbbrev,
      precision: rec.netPrecision,
      fired: shallowCopy(prev.fired || {}),
      lastSeen: nowMs
    };

    var prevNetMs = Date.parse(String(prev.net || ""));
    var rescheduled = isFinite(prevNetMs)
      && Math.abs(rec.netMs - prevNetMs) > RESCHEDULE_EPSILON_MS;
    var statusChanged = String(prev.status || "") !== rec.statusAbbrev;

    if (rescheduled) {
      events.push({ kind: "rescheduled", launch: rec, previousNetMs: prevNetMs });
      // The old countdown alerts are void. Re-arm the tiers, but suppress any
      // the new time is already inside so a setback emits one alert, not three.
      entry.fired = firedAtFirstSight(remaining);
    } else if (statusChanged) {
      events.push({
        kind: statusEventKind(rec.statusAbbrev),
        launch: rec,
        from: String(prev.status || ""),
        to: rec.statusAbbrev
      });
    }

    if (rec.precise) {
      for (var t = 0; t < TIERS.length; t++) {
        var tier = TIERS[t];
        if (!entry.fired[tier.key] && remaining > 0 && remaining <= tier.ms) {
          events.push({ kind: tier.key, launch: rec });
          entry.fired[tier.key] = true;
        }
      }
    }

    nextLaunches[rec.id] = entry;
  }

  return {
    state: { version: 1, launches: nextLaunches, updatedAt: nowMs },
    events: events
  };
}

// Copy of the tier list minus the ones the user switched off.
function enabledTierKeys(settings) {
  settings = settings || {};
  var keys = [];
  if (settings.notify24h !== false) keys.push("t24");
  if (settings.notify1h !== false) keys.push("t1");
  if (settings.notify10m !== false) keys.push("t10");
  return keys;
}

function filterEvents(events, settings) {
  settings = settings || {};
  var tiers = enabledTierKeys(settings);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var isTier = ev.kind === "t24" || ev.kind === "t1" || ev.kind === "t10";
    if (isTier) {
      if (tiers.indexOf(ev.kind) !== -1) out.push(ev);
      continue;
    }
    if (ev.kind === "rescheduled" || ev.kind === "scrubbed" || ev.kind === "hold"
      || ev.kind === "go" || ev.kind === "liftoff") {
      if (settings.notifyChanges !== false) out.push(ev);
      continue;
    }
    // success/failure/status are informational and intentionally silent.
  }
  return out;
}

// Presentation for one event: what the toast says, how loud it is, its glyph.
// Vehicle-first titles so a glance at the notification says which rocket.
// Noteworthy missions (crew, Starship, Heavy) escalate the 1-hour and
// liftoff toasts to critical; routine runs stay at their base level.
function notificationContent(ev) {
  var rec = (ev && ev.launch) || {};
  var vehicle = rec.vehicle !== "" ? rec.vehicle : "SpaceX";
  var mission = rec.mission !== "" ? rec.mission : (rec.name || "Launch");
  var when = rec.netMs ? localDayClock(rec.netMs) : "";
  var notable = classifyMission(rec.mission, rec.vehicle).noteworthy;

  function title(suffix) { return vehicle + " · " + suffix; }

  switch (ev.kind) {
    case "rescheduled":
      return { title: title("Rescheduled"), body: mission + " → " + when, urgency: "critical", glyph: "" };
    case "scrubbed":
      return { title: title("Scrubbed"), body: mission + " was scrubbed", urgency: "critical", glyph: "" };
    case "hold":
      return { title: title("On hold"), body: mission, urgency: "normal", glyph: "" };
    case "go":
      return { title: title("Go for launch"), body: mission + " · " + when, urgency: "normal", glyph: "" };
    case "liftoff":
      return { title: title("Liftoff"), body: mission + " is flying", urgency: notable ? "critical" : "normal", glyph: "" };
    case "t24":
      return { title: title("Launch tomorrow"), body: mission + " · " + when, urgency: "normal", glyph: "" };
    case "t1":
      return { title: title("Launch in 1 hour"), body: mission + " · " + when, urgency: notable ? "critical" : "normal", glyph: "" };
    case "t10":
      return { title: title("Launch in 10 minutes"), body: mission + " · " + when, urgency: "critical", glyph: "" };
    default:
      return { title: title("Launch update"), body: mission, urgency: "low", glyph: "" };
  }
}

// Stable numeric id for the notification daemon's replace-id, so each new
// countdown tier replaces the previous toast instead of stacking three.
function replaceId(launchId, kind) {
  var s = String(launchId || "launch") + ":" + String(kind || "x");
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2000000000;
}

// --- state persistence -----------------------------------------------------

function emptyState() {
  return { version: 1, launches: {} };
}

function parseState(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""));
    if (parsed && typeof parsed === "object" && parsed.launches
      && typeof parsed.launches === "object") {
      return { version: 1, launches: parsed.launches, updatedAt: Number(parsed.updatedAt || 0) };
    }
  } catch (e) {}
  return emptyState();
}

function serializeState(state) {
  var s = state || emptyState();
  return JSON.stringify({
    version: 1,
    launches: s.launches || {},
    updatedAt: Number(s.updatedAt || 0)
  });
}

// --- tooltip / summary helpers --------------------------------------------

function statusColorKey(rec) {
  if (!rec) return "dim";
  var a = String(rec.statusAbbrev || "").toLowerCase();
  if (a.indexOf("go") !== -1) return "go";
  if (a.indexOf("hold") !== -1 || a.indexOf("scrub") !== -1) return "urgent";
  if (a.indexOf("flight") !== -1 || a.indexOf("success") !== -1) return "go";
  if (a.indexOf("fail") !== -1) return "urgent";
  return "dim";
}

function statusLabel(rec) {
  if (!rec) return "";
  return rec.statusName !== "" ? rec.statusName : rec.statusAbbrev;
}

function summaryText(rec, nowMs) {
  if (!rec) return "No upcoming SpaceX launches.";
  var parts = [rec.mission || rec.name];
  if (isFinite(rec.netMs)) parts.push(localLong(rec.netMs));
  return parts.join(" · ");
}

if (typeof module !== "undefined") {
  module.exports = {
    API_BASE: API_BASE,
    UPCOMING_LIMIT: UPCOMING_LIMIT,
    USER_AGENT: USER_AGENT,
    TIERS: TIERS,
    LIFTOFF_GRACE_MS: LIFTOFF_GRACE_MS,
    RESCHEDULE_EPSILON_MS: RESCHEDULE_EPSILON_MS,
    PAD_TIMEZONES: PAD_TIMEZONES,
    STAGE_IDLE_MS: STAGE_IDLE_MS,
    STAGE_FINAL_MS: STAGE_FINAL_MS,
    STAGE_LIFTOFF_MS: STAGE_LIFTOFF_MS,
    pad2: pad2,
    upcomingUrl: upcomingUrl,
    bestWebcast: bestWebcast,
    classifyMission: classifyMission,
    normalizeLaunch: normalizeLaunch,
    parseUpcoming: parseUpcoming,
    padTimezone: padTimezone,
    US_ZONES: US_ZONES,
    zoneOffsetHours: zoneOffsetHours,
    isZoneDst: isZoneDst,
    nthWeekday: nthWeekday,
    stageFor: stageFor,
    sunElevationDeg: sunElevationDeg,
    skyPhaseFor: skyPhaseFor,
    skyPhaseValue: skyPhaseValue,
    imageUrl: imageUrl,
    pickNext: pickNext,
    localClock: localClock,
    localDayClock: localDayClock,
    localLong: localLong,
    formatInZone: formatInZone,
    formatDayInZone: formatDayInZone,
    tzAbbrev: tzAbbrev,
    formatClock: formatClock,
    formatDays: formatDays,
    formatBarCountdown: formatBarCountdown,
    formatPanelCountdown: formatPanelCountdown,
    compactDur: compactDur,
    windowCaption: windowCaption,
    flightLine: flightLine,
    firedAtFirstSight: firedAtFirstSight,
    statusEventKind: statusEventKind,
    sceneOverride: sceneOverride,
    planNotifications: planNotifications,
    enabledTierKeys: enabledTierKeys,
    filterEvents: filterEvents,
    notificationContent: notificationContent,
    replaceId: replaceId,
    emptyState: emptyState,
    parseState: parseState,
    serializeState: serializeState,
    statusColorKey: statusColorKey,
    statusLabel: statusLabel,
    summaryText: summaryText
  };
}
