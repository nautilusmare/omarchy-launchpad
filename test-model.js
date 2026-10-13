// Quick checks for Model.js — run with: node test-model.js
var Model = require("./Model.js")

var failures = 0
function check(name, cond, extra) {
  if (!cond) {
    failures++
    console.log("FAIL " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : ""))
  } else {
    console.log("ok   " + name)
  }
}

function ms(iso) { return Date.parse(iso) }

// --- url -------------------------------------------------------------------
check("upcomingUrl filters SpaceX",
  Model.upcomingUrl().indexOf("lsp__name=SpaceX") !== -1
  && Model.upcomingUrl().indexOf("mode=detailed") !== -1
  && Model.upcomingUrl().indexOf("ordering=net") !== -1)
check("upcomingUrl honours limit", Model.upcomingUrl(3).indexOf("limit=3") !== -1)

// --- bestWebcast -----------------------------------------------------------
var vids = [
  { url: "https://y/u1", type: { name: "Unofficial Webcast" } },
  { url: "https://x/official", type: { name: "Official Webcast" } },
  { url: "https://y/restream", type: { name: "Unofficial Re-stream" } }
]
check("bestWebcast prefers official", Model.bestWebcast(vids).url === "https://x/official")
check("bestWebcast falls back to webcast",
  Model.bestWebcast([vids[0], vids[2]]).url === "https://y/u1")
check("bestWebcast empty", Model.bestWebcast([]).url === "" && Model.bestWebcast(null).url === "")

// --- classifyMission -------------------------------------------------------
check("classify crew", Model.classifyMission("Crew-9", "Falcon 9 Block 5").crew === true)
check("classify cargo dragon is not crew",
  Model.classifyMission("Dragon CRS-2 SpX-35", "Falcon 9 Block 5").crew === false)
check("classify starship", Model.classifyMission("Flight 15", "Starship").starship === true)
check("classify superheavy", Model.classifyMission("Super Heavy test", "").starship === true)
check("classify falcon heavy", Model.classifyMission("Griffin Mission One", "Falcon Heavy").heavy === true)
check("classify starlink routine", (function () {
  var f = Model.classifyMission("Starlink Group 15-25", "Falcon 9 Block 5")
  return f.starlink === true && f.noteworthy === false
})())
check("classify polaris crew", Model.classifyMission("Polaris Dawn", "Falcon 9 Block 5").crew === true)
check("crew is noteworthy", Model.classifyMission("Crew-10", "Falcon 9 Block 5").noteworthy === true)
check("cargo crs not noteworthy", Model.classifyMission("Cygnus CRS-2 NG-25", "Falcon 9 Block 5").noteworthy === false)

// --- padTimezone -----------------------------------------------------------
check("tz SLC-4E", Model.padTimezone("Space Launch Complex 4E") === "America/Los_Angeles")
check("tz SLC-40", Model.padTimezone("Space Launch Complex 40") === "America/New_York")
check("tz LC-39A", Model.padTimezone("Launch Complex 39A") === "America/New_York")
check("tz Starbase", Model.padTimezone("Orbital Launch Mount A") === "America/Chicago")
check("tz unknown empty", Model.padTimezone("") === "")

// --- parseUpcoming ---------------------------------------------------------
var fixture = {
  count: 2,
  results: [
    {
      id: "abc", slug: "falcon-9-sda", url: "https://ll/abc",
      name: "Falcon 9 Block 5 | SDA Tranche 1 Transport Layer A",
      net: "2026-10-10T07:39:00Z", window_start: "2026-10-10T07:39:00Z",
      net_precision: { abbrev: "MIN" },
      status: { id: 1, abbrev: "Go", name: "Go for Launch" },
      probability: null,
      pad: {
        name: "Space Launch Complex 4E",
        latitude: 34.632, longitude: -120.611,
        location: { name: "Vandenberg SFB, CA, USA" }
      },
      mission: { type: "Government/Top Secret" },
      vidURLs: vids,
      image: { image_url: "https://img/f9.jpeg" }
    },
    {
      id: "def", slug: "starship-flight-15",
      name: "Starship | Flight 15",
      net: "2026-12-31T00:00:00Z",
      net_precision: { abbrev: "Q4" },
      status: { id: 2, abbrev: "TBD", name: "To Be Determined" },
      pad: { name: "Suborbital Pad B", location: { name: "Starbase, TX, USA" } },
      mission: { type: "Test Flight" },
      vidURLs: [],
      image: "https://img/ss.jpeg"
    }
  ]
}
var parsed = Model.parseUpcoming(JSON.stringify(fixture))
check("parse count", parsed.length === 2)
check("parse splits vehicle/mission",
  parsed[0].vehicle === "Falcon 9 Block 5"
  && parsed[0].mission === "SDA Tranche 1 Transport Layer A")
check("parse net ms", parsed[0].netMs === ms("2026-10-10T07:39:00Z"))
check("parse precise MIN", parsed[0].precise === true)
check("parse coarse Q4 not precise", parsed[1].precise === false)
check("parse status abbrev", parsed[0].statusAbbrev === "Go")
check("parse probability -1 when null", parsed[0].probability === -1)
check("parse timezone from pad", parsed[0].timezone === "America/Los_Angeles")
check("parse webcast official", parsed[0].webcastUrl === "https://x/official")
check("parse image object", parsed[0].imageUrl === "https://img/f9.jpeg")
check("parse image string", parsed[1].imageUrl === "https://img/ss.jpeg")
check("parse starship flag", parsed[1].flags.starship === true)
check("parse junk", Model.parseUpcoming("<html>").length === 0)
check("parse empty", Model.parseUpcoming("{}").length === 0)

// --- pickNext --------------------------------------------------------------
var now = ms("2026-10-09T19:00:00Z")
check("pickNext first live", Model.pickNext(parsed, now).id === "abc")
check("pickNext skips expired",
  Model.pickNext(parsed, ms("2026-11-01T00:00:00Z")).id === "def")
check("pickNext null when all past",
  Model.pickNext(parsed, ms("2027-06-01T00:00:00Z")) === null)

// --- formatting ------------------------------------------------------------
check("clock pad", Model.formatClock(3661000).indexOf("01:01:01") !== -1)
check("clock negative is T+", Model.formatClock(-5000).indexOf("T+") === 0)
check("days", Model.formatDays(90000000) === "1d 1h")
check("bar countdown silent far out", Model.formatBarCountdown(parsed[0], ms("2026-10-08T00:00:00Z")) === "")
check("bar countdown silent just over an hour", (function () {
  var r = Model.normalizeLaunch(fixture.results[0])
  return Model.formatBarCountdown(r, r.netMs - 3600001) === ""
})())
check("bar countdown near", (function () {
  var r = Model.normalizeLaunch(fixture.results[0])
  return Model.formatBarCountdown(r, r.netMs - 3600000).indexOf("01:00:00") !== -1
})())
check("bar coarse never shows timer", (function () {
  var r = Model.normalizeLaunch(fixture.results[1])
  var s = Model.formatBarCountdown(r, r.netMs - 3600000)
  return s === ""
})())
check("panel countdown coarse empty", Model.formatPanelCountdown(parsed[1], now) === "")
check("panel countdown precise", Model.formatPanelCountdown(parsed[0], now).indexOf("T-") === 0)

// --- sceneOverride: the scene's honesty about holds -------------------------
check("override null", Model.sceneOverride(null) === "")
check("override go is live", Model.sceneOverride({ statusAbbrev: "Go" }) === "")
check("override hold freezes", Model.sceneOverride({ statusAbbrev: "Hold" }) === "hold")
check("override hold substring", Model.sceneOverride({ statusAbbrev: "Countdown Hold" }) === "hold")
check("override in flight forces liftoff", Model.sceneOverride({ statusAbbrev: "In Flight" }) === "flight")
check("override success is live", Model.sceneOverride({ statusAbbrev: "Success" }) === "")

// --- windowCaption: where the wall clock stands against the window ---------
check("window opens", Model.windowCaption({ windowStartMs: 10000000, windowEndMs: 20000000 }, 5000000) === "WINDOW OPENS IN 1H 23M")
check("window closes", Model.windowCaption({ windowStartMs: 10000000, windowEndMs: 20000000 }, 15000000) === "WINDOW CLOSES IN 1H 23M")
check("window minutes only", Model.windowCaption({ windowStartMs: 10000000, windowEndMs: 20000000 }, 9000000) === "WINDOW OPENS IN 16M")
check("window past", Model.windowCaption({ windowStartMs: 10000000, windowEndMs: 20000000 }, 25000000) === "")
check("window missing", Model.windowCaption({ windowStartMs: NaN, windowEndMs: 20000000 }, 5000000) === "")
check("window inverted", Model.windowCaption({ windowStartMs: 20000000, windowEndMs: 10000000 }, 5000000) === "")
check("window null", Model.windowCaption(null, 5000000) === "")

// --- normalizeLaunch: new in-payload fields ----------------------------------
var richLaunch = {
  id: "rich-1",
  name: "Falcon 9 Block 5 | Starlink Group 15-25",
  net: "2026-10-13T00:11:44Z",
  net_precision: { abbrev: "SEC" },
  status: { id: 1, name: "Go for Launch", abbrev: "Go" },
  pad: { name: "Space Launch Complex 4E", latitude: "34.632", longitude: "-120.611", location: { name: "Vandenberg SFB, CA, USA" } },
  window_start: "2026-10-13T00:11:44Z",
  window_end: "2026-10-13T04:11:44Z",
  probability: 80,
  webcast_live: true,
  vidURLs: [{ url: "https://y/w", type: { name: "Official Webcast" } }],
  image: "https://img/generic.png",
  mission_patches: [
    { image_url: "https://img/low.png", priority: 1 },
    { image_url: "https://img/high.png", priority: 10 }
  ],
  mission: { type: "Communications", description: "A batch of 27 satellites.", orbit: { name: "Low Earth Orbit", abbrev: "LEO" } },
  rocket: { configuration: { successful_launches: 636, failed_launches: 1 } }
}
var rich = Model.normalizeLaunch(richLaunch)
check("rich patch prefers priority", rich.patchUrl === "https://img/high.png")
check("rich webcastLive", rich.webcastLive === true)
check("rich blurb", rich.missionBlurb === "A batch of 27 satellites.")
check("rich orbit abbrev", rich.orbit === "LEO")
check("rich flightsFlown", rich.flightsFlown === 637)
check("rich flags starlink quiet", rich.flags.starlink === true && rich.flags.noteworthy === false)
check("rich patch falls back to image", Model.normalizeLaunch({ name: "x", net: "2026-10-13T00:11:44Z" }).patchUrl === "")
check("flightLine full", Model.flightLine(rich) === "FALCON 9 BLOCK 5 · 637 FLOWN")
check("flightLine unknown", Model.flightLine({ vehicle: "Falcon 9", flightsFlown: NaN }) === "")
check("flightLine null", Model.flightLine(null) === "")

// --- launchResult: no LIVE once the outcome is known ------------------------
check("result success", Model.launchResult({ statusAbbrev: "Success" }) === "success")
check("result failure", Model.launchResult({ statusAbbrev: "Failure" }) === "failure")
check("result open", Model.launchResult({ statusAbbrev: "Go" }) === "")
check("result null", Model.launchResult(null) === "")
check("bar silent after success", (function () {
  var r = Model.normalizeLaunch(fixture.results[0])
  r.statusAbbrev = "Success"
  return Model.formatBarCountdown(r, r.netMs + 3600000) === ""
})())
check("bar silent after failure", (function () {
  var r = Model.normalizeLaunch(fixture.results[0])
  r.statusAbbrev = "Failure"
  return Model.formatBarCountdown(r, r.netMs + 3600000) === ""
})())
check("bar live when outcome open", (function () {
  var r = Model.normalizeLaunch(fixture.results[0])
  r.statusAbbrev = "Go"
  return Model.formatBarCountdown(r, r.netMs + 3600000) === "LIVE"
})())

// --- planNotifications: first sight is silent ------------------------------
var nowMs = ms("2026-10-09T07:39:00Z") // exactly T-24h for abc
var plan1 = Model.planNotifications(parsed, Model.emptyState(), nowMs)
check("first sight emits nothing", plan1.events.length === 0, plan1.events.map(function (e) { return e.kind }))
check("first sight records launch", !!plan1.state.launches.abc)
// at T-24h exactly, the t24 tier is already considered fired
check("first sight inside t24 marks fired", plan1.state.launches.abc.fired.t24 === true)

// --- tier crossing ---------------------------------------------------------
// First seen at T-25h (outside every tier): nothing fires, all tiers armed.
var t25 = parsed[0].netMs - 25 * 3600000
var p0 = Model.planNotifications([parsed[0]], Model.emptyState(), t25)
check("armed at T-25h", p0.events.length === 0 && p0.state.launches.abc.fired.t24 === false)

// Cross T-24h.
var t23h59 = parsed[0].netMs - (24 * 3600000 - 1000)
var p1 = Model.planNotifications([parsed[0]], p0.state, t23h59)
check("t24 fires once", p1.events.length === 1 && p1.events[0].kind === "t24", p1.events.map(function (e) { return e.kind }))

// Same again: no duplicate.
var p2 = Model.planNotifications([parsed[0]], p1.state, t23h59 + 60000)
check("t24 does not repeat", p2.events.length === 0)

// A poll gap of an hour straddling both thresholds fires t1 then t10 in order.
var p3 = Model.planNotifications([parsed[0]], p2.state, parsed[0].netMs - 5 * 60000)
check("t1 and t10 fire", p3.events.length === 2
  && p3.events[0].kind === "t1" && p3.events[1].kind === "t10",
  p3.events.map(function (e) { return e.kind }))

// --- coarse-precision launch never gets tier alerts ------------------------
var ss = parsed[1]
var ssPlanA = Model.planNotifications([ss], Model.emptyState(), ss.netMs - 25 * 3600000)
var ssPlanB = Model.planNotifications([ss], ssPlanA.state, ss.netMs - 30 * 60000)
check("coarse launch: no tier alerts", ssPlanB.events.length === 0)

// --- reschedule ------------------------------------------------------------
var moved = Model.normalizeLaunch(Object.assign({}, fixture.results[0], { net: "2026-10-12T07:39:00Z" }))
var rp = Model.planNotifications([moved], p1.state, parsed[0].netMs - 3600000)
check("reschedule fires", rp.events.length === 1 && rp.events[0].kind === "rescheduled",
  rp.events.map(function (e) { return e.kind }))
check("reschedule re-arms future tiers", rp.state.launches.abc.fired.t1 === false)

// Tiny nudge is not a reschedule.
var nudged = Model.normalizeLaunch(Object.assign({}, fixture.results[0], { net: "2026-10-10T07:39:30Z" }))
var np = Model.planNotifications([nudged], p1.state, parsed[0].netMs - 3600000)
check("sub-minute nudge is silent", np.events.length === 0, np.events.map(function (e) { return e.kind }))

// --- status change ---------------------------------------------------------
var held = Model.normalizeLaunch(Object.assign({}, fixture.results[0], { status: { id: 3, abbrev: "Hold", name: "Launch on Hold" } }))
var hp = Model.planNotifications([held], p1.state, parsed[0].netMs - 3600000)
check("hold fires", hp.events.some(function (e) { return e.kind === "hold" }),
  hp.events.map(function (e) { return e.kind }))

// --- filterEvents ----------------------------------------------------------
check("filter drops disabled tier", Model.filterEvents([{ kind: "t24" }], { notify24h: false }).length === 0)
check("filter keeps enabled tier", Model.filterEvents([{ kind: "t24", launch: {} }], { notify24h: true }).length === 1)
check("filter drops changes when off",
  Model.filterEvents([{ kind: "scrubbed", launch: {} }], { notifyChanges: false }).length === 0)
check("filter drops silent kinds",
  Model.filterEvents([{ kind: "success", launch: {} }], {}).length === 0)

// --- notificationContent ---------------------------------------------------
check("t10 is critical", Model.notificationContent({ kind: "t10", launch: parsed[0] }).urgency === "critical")
check("rescheduled is critical", Model.notificationContent({ kind: "rescheduled", launch: parsed[0] }).urgency === "critical")
check("title carries vehicle", Model.notificationContent({ kind: "t1", launch: parsed[0] }).title.indexOf("Falcon 9") === 0)
check("body carries mission", Model.notificationContent({ kind: "t1", launch: parsed[0] }).body.indexOf("SDA") !== -1)
check("crew t1 is critical", Model.notificationContent({ kind: "t1", launch: { vehicle: "Falcon 9 Block 5", mission: "Crew-9" } }).urgency === "critical")
check("starlink t1 stays normal", Model.notificationContent({ kind: "t1", launch: { vehicle: "Falcon 9 Block 5", mission: "Starlink Group 15-25" } }).urgency === "normal")
check("crew liftoff is critical", Model.notificationContent({ kind: "liftoff", launch: { vehicle: "Starship", mission: "Flight 15" } }).urgency === "critical")

// --- state round-trip ------------------------------------------------------
var round = Model.parseState(Model.serializeState(p3.state))
check("state round-trips", !!round.launches.abc && round.launches.abc.fired.t1 === true)
check("parseState junk", Object.keys(Model.parseState("garbage").launches).length === 0)
check("parseState empty", Object.keys(Model.parseState("").launches).length === 0)

// --- summary / status ------------------------------------------------------
check("statusColorKey go", Model.statusColorKey(parsed[0]) === "go")
check("statusColorKey tbd dim", Model.statusColorKey(parsed[1]) === "dim")
check("summary includes mission", Model.summaryText(parsed[0], now).indexOf("SDA") !== -1)
check("summary handles null", Model.summaryText(null, now).indexOf("No upcoming") === 0)

// --- pad zones (no Intl in Quickshell, so the offsets are exact rules) -----
// SDA Tranche 1's T-0, 07:39Z, is 00:39 the previous night at Vandenberg.
check("pad time west coast", Model.formatInZone(parsed[0].netMs, "America/Los_Angeles") === "00:39")
check("pad day west coast", Model.formatDayInZone(parsed[0].netMs, "America/Los_Angeles") === "Sat 00:39")
check("pad abbrev PDT", Model.tzAbbrev(parsed[0].netMs, "America/Los_Angeles") === "PDT")
check("pad time east coast", Model.formatInZone(ms("2026-06-15T12:00:00Z"), "America/New_York") === "08:00")
check("pad abbrev EDT", Model.tzAbbrev(ms("2026-06-15T12:00:00Z"), "America/New_York") === "EDT")
check("pad abbrev CST", Model.tzAbbrev(ms("2026-06-15T12:00:00Z"), "America/Chicago") === "CDT")
// January is standard time.
check("winter is standard", Model.tzAbbrev(ms("2026-01-15T12:00:00Z"), "America/New_York") === "EST"
  && Model.formatInZone(ms("2026-01-15T12:00:00Z"), "America/New_York") === "07:00")

// US DST in 2026: starts the second Sunday in March (the 8th) at 02:00 local,
// ends the first Sunday in November (the 1st) at 02:00 local.
check("DST starts at the instant", Model.tzAbbrev(ms("2026-03-08T09:59:59Z"), "America/Los_Angeles") === "PST"
  && Model.tzAbbrev(ms("2026-03-08T10:00:00Z"), "America/Los_Angeles") === "PDT")
check("DST ends at the instant", Model.tzAbbrev(ms("2026-11-01T05:59:59Z"), "America/New_York") === "EDT"
  && Model.tzAbbrev(ms("2026-11-01T06:00:00Z"), "America/New_York") === "EST")
check("spring forward skips an hour", Model.formatInZone(ms("2026-03-08T09:30:00Z"), "America/Los_Angeles") === "01:30"
  && Model.formatInZone(ms("2026-03-08T10:30:00Z"), "America/Los_Angeles") === "03:30")
check("fall back repeats an hour", Model.formatInZone(ms("2026-11-01T05:30:00Z"), "America/New_York") === "01:30"
  && Model.formatInZone(ms("2026-11-01T06:30:00Z"), "America/New_York") === "01:30")
check("unknown zones stay silent", Model.formatInZone(parsed[0].netMs, "Europe/Berlin") === ""
  && Model.tzAbbrev(parsed[0].netMs, "Europe/Berlin") === ""
  && Model.formatInZone(parsed[0].netMs, "") === ""
  && Model.tzAbbrev(parsed[0].netMs, null) === "")
check("zone offsets reject junk", isNaN(Model.zoneOffsetHours(NaN, "America/New_York"))
  && isNaN(Model.zoneOffsetHours(Date.now(), "Mars/Olympus")))
check("nth weekday finds the second Sunday", Model.nthWeekday(2026, 2, 0, 2) === 8
  && Model.nthWeekday(2026, 10, 0, 1) === 1)

// --- launch scene ----------------------------------------------------------
var MIN = 60 * 1000
var HOUR = 60 * MIN
var DAY = 24 * HOUR

check("stage idle beyond a day", Model.stageFor(25 * HOUR) === "idle")
check("stage approach inside a day", Model.stageFor(23 * HOUR) === "approach")
check("stage final inside ten minutes", Model.stageFor(9 * MIN) === "final")
check("stage liftoff at T-0", Model.stageFor(0) === "liftoff")
check("stage liftoff right after T-0", Model.stageFor(-90 * 1000) === "liftoff")
check("stage stamp once the finale ends", Model.stageFor(-5 * MIN) === "stamp")
check("stage handles bad input", Model.stageFor(undefined) === "idle" && Model.stageFor("x") === "idle")
check("stage boundaries are exact", Model.stageFor(DAY) === "approach" && Model.stageFor(10 * MIN) === "final")

// Elevation checked against sunrise-sunset.org for Houston on 2026-10-10
// (sunrise 12:19:03Z, sunset 23:57:44Z): the sun should sit just below the
// horizon at both, and high at solar noon.
check("sun elevation at sunrise is horizon-ish",
  Math.abs(Model.sunElevationDeg(ms("2026-10-10T12:19:03Z"), 29.76, -95.37) - (-0.83)) < 1.5)
check("sun elevation at sunset is horizon-ish",
  Math.abs(Model.sunElevationDeg(ms("2026-10-10T23:57:44Z"), 29.76, -95.37) - (-0.83)) < 1.5)
check("sun elevation peaks at solar noon",
  Model.sunElevationDeg(ms("2026-10-10T18:08:23Z"), 29.76, -95.37) > 50)
check("sun elevation rejects junk",
  !isFinite(Model.sunElevationDeg(Date.now(), NaN, 0)) && !isFinite(Model.sunElevationDeg(null, 0, 0)))

// The SDA Tranche 1 T-0 is 07:39Z, i.e. dead of night at Vandenberg.
check("sky deep for a midnight launch", Model.skyPhaseFor(parsed[0].netMs, parsed[0].padLat, parsed[0].padLng) === "deep")
check("sky day for a midday launch",
  Model.skyPhaseFor(ms("2026-10-10T18:00:00Z"), 29.76, -95.37) === "day")
check("sky unknown without coordinates",
  Model.skyPhaseFor(Date.now(), NaN, NaN) === "unknown"
  && Model.skyPhaseFor(Date.now(), undefined, 0) === "unknown")
check("skyPhaseValue spans the range",
  Model.skyPhaseValue("day") === 1 && Model.skyPhaseValue("deep") === 0
  && Model.skyPhaseValue("nope") === 0.5)

if (failures > 0) {
  console.log("\n" + failures + " failure(s)")
  process.exit(1)
}
console.log("\nall checks passed")
