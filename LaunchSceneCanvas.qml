import QtQuick
import "launch-scene.js" as SceneLib

// Hosts the canvas launch scene in launch-scene.js inside a QML Canvas.
//
// The scene's phases hang off one thing we actually know: seconds to T-0. So
// the ladder it animates — pad, fuelling, the last ten seconds, liftoff, the
// arc, the booster landing, the recap — is anchored to the real countdown
// rather than to telemetry no free API gives us. Daylight comes from the real
// sun position at the pad (Model.skyPhaseFor), so a night launch really is
// drawn at night.
//
// Frames are driven by `active`, which is the panel's open state: closed, the
// scene is neither painted nor simulated. `toggleReplay()` swaps the live
// clock for a ~38s virtual one that re-flies the whole sequence.
Canvas {
  id: host

  // --- inputs ----------------------------------------------------------------
  property bool active: false           // panel open: paint and advance
  property real nowMs: 0
  property real netMs: NaN
  property real daylight: 0             // 0 night .. 1 day, from the real sun
  property string landingResult: "success"
  // Backing-store scale. Qt's Canvas applies its own base transform on some
  // versions and not on others; 1 keeps the drawing exactly filling the item
  // either way.
  property real pixelRatio: 1

  // Seconds around T-0, in the library's convention: negative before launch,
  // positive after. This is the one true input the whole scene hangs off.
  readonly property real secondsToT0: host.nowMs - host.netMs

  property var scene: null

  // Real-status override from the API (Model.sceneOverride): "hold" freezes
  // the scene where the clock stood, "flight" forces ignition when the clock
  // slipped but the vehicle is already climbing. "" follows the live clock.
  property string sceneOverride: ""
  // Virtual seconds captured when a hold starts; the scene freezes there.
  property double holdFreezeT: -1e18

  onSceneOverrideChanged: {
    if (host.sceneOverride === "hold" && isFinite(host.secondsToT0s))
      host.holdFreezeT = Math.min(host.secondsToT0s, -1);
    host.requestPaint();
  }

  // Active-flight moments (the last seconds around T-0 through the landing)
  // deserve a smoother cadence; the long idle/approach stretches do not.
  // 50ms = 20fps for the drama, 100ms = 10fps for the drift.
  // NOTE: secondsToT0 is milliseconds; the gate below divides by 1000 first.
  // (An earlier version compared ms against second thresholds, so the fast
  // cadence never engaged.)
  readonly property real secondsToT0s: host.secondsToT0 / 1000
  // 20fps only for the real liftoff drama (T-30s..T+60s). Everything else is
  // slow motion a human eye can't see past 10fps — and at ~30ms of software
  // raster per heavy frame, 20fps would peg most of a core. The compressed
  // replay runs at 10fps for the same reason; hours out, 5fps drifts plenty.
  readonly property bool dramaPhase: isFinite(host.secondsToT0s)
    && host.secondsToT0s > -30 && host.secondsToT0s < 60
  // Hours out, the pad scene barely moves (clouds drift, stars twinkle), so
  // a slow drift cadence is plenty — and the panel countdown ticks at 1s
  // regardless of how often the scene paints.
  readonly property bool farField: isFinite(host.secondsToT0s)
    && Math.abs(host.secondsToT0s) > 3600

  // --- cinematic replay ------------------------------------------------------
  // A compressed re-flight of the whole sequence (~38s wall time), driven by
  // a virtual clock so every phase and milestone fires in order. setT() is a
  // seek, so smooth per-frame steps keep all events firing as they should.
  readonly property real replayDurationMs: 38000
  property bool replaying: false
  property double replayT0: 0
  property real replayProgress: 0

  // Virtual T-0-relative seconds for the replay, or null when it is over.
  function replayT() {
    var e = Date.now() - host.replayT0;
    if (e < 0) return -2100;
    if (e < 4000) return -2100 + 2090 * (e / 4000);          // fuelling ~520x
    if (e < 12000) return -10 + 10 * ((e - 4000) / 8000);    // countdown ~1.25x
    if (e < 15000) return 10 * ((e - 12000) / 3000);         // liftoff
    if (e < 29000) return 10 + 490 * ((e - 15000) / 14000);  // ascent ~35x
    if (e < 35000) return 500 + 80 * ((e - 29000) / 6000);   // landing
    if (e < 38000) return 580 + 40 * ((e - 35000) / 3000);   // recap
    return null;
  }

  function toggleReplay() {
    if (host.replaying) {
      host.replaying = false;
    } else {
      host.replayT0 = Date.now();
      host.replayProgress = 0;
      host.replaying = true;
      host.requestPaint();
    }
  }

  onReplayingChanged: replayIcon.requestPaint()

  function rebuild() {
    host.scene = null;
    host.requestPaint();
  }

  // --- painting --------------------------------------------------------------
  onPaint: {
    var ctx = getContext("2d");
    if (host.scene === null) {
      SceneLib.setEnv("devicePixelRatio", host.pixelRatio);
      host.scene = SceneLib.createScene({
        ctx: ctx,
        width: host.width,
        height: host.height,
        daylight: host.daylight,
        // Quickshell's canvas is software-rendered on the GUI thread: every
        // millisecond spent in here delays the panel's own open animation,
        // IPC, and input. Keep the plume well under the browser default.
        maxParticles: 300
      });
      host.scene.setLandingResult(host.landingResult);
    }
    // Feed the clock before the library's own frame tick, so the phase and
    // its progress are always the true ones. While replaying, the virtual
    // cinematic clock wins; when it runs out, the live clock takes over.
    // The context is handed to the scene on every paint: Qt gives a fresh
    // wrapper per pass, and the one from an earlier paint is no longer usable.
    var vt = host.replaying ? host.replayT() : null;
    if (host.replaying && vt === null) host.replaying = false;
    if (host.replaying) {
      host.scene.setT(vt);
      host.replayProgress = Math.min(1, (Date.now() - host.replayT0) / host.replayDurationMs);
    } else if (host.sceneOverride === "hold") {
      // Real hold from the API: freeze where the clock stood when the hold
      // was detected (never past T-1), instead of sailing past T-0.
      host.scene.setT(Math.min(host.holdFreezeT, -1));
    } else if (host.sceneOverride === "flight" && host.secondsToT0s < 2) {
      // Real liftoff with a slipped clock: show ignition, not the pad.
      host.scene.setT(2);
    } else if (isFinite(host.secondsToT0)) host.scene.setT(host.secondsToT0 / 1000);
    else host.scene.setPhase("idle");
    host.scene.ctx = ctx;
    var frame = SceneLib.frameSink();
    if (frame) frame(Date.now());
  }

  // The library wants a frame; a closed panel must not get one. The cadence
  // follows the drama: full speed only around T-0, a slow drift otherwise.
  //
  // `settled` holds the loop off for the first moment after open: the panel
  // window's own map/commit and fade-in need the GUI thread, and starting the
  // frame loop in the same instant they do is what made the popup take
  // seconds to appear.
  property bool settled: false

  onActiveChanged: {
    host.settled = false
    if (host.active) {
      host.requestPaint()
      settleTimer.restart()
    } else {
      settleTimer.stop()
      host.replaying = false
      host.replayProgress = 0
    }
  }

  Timer {
    id: settleTimer
    interval: 250
    onTriggered: if (host.active) host.settled = true
  }

  Timer {
    interval: host.dramaPhase ? 50 : (host.replaying || !host.farField ? 100 : 200)
    repeat: true
    running: host.active && host.settled && host.scene !== null
    onTriggered: host.requestPaint()
  }

  // Re-size the scene's geometry when the panel changes width.
  onWidthChanged: if (host.scene) host.scene.resize()
  onHeightChanged: if (host.scene) host.scene.resize()
  onDaylightChanged: if (host.scene) host.scene.setDaylight(host.daylight)
  onLandingResultChanged: if (host.scene) host.scene.setLandingResult(host.landingResult)

  // --- replay controls (drawn above the scene) -------------------------------
  // Play/stop button, bottom-right. A tiny static canvas keeps the glyph
  // deterministic with no font dependency; it repaints only when the
  // replaying state flips.
  Item {
    width: 32
    height: 32
    anchors.right: parent.right
    anchors.rightMargin: 8
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 10

    Canvas {
      id: replayIcon
      anchors.fill: parent
      onPaint: {
        var ctx = getContext("2d");
        var s = width;
        ctx.clearRect(0, 0, s, s);
        ctx.beginPath();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        if (host.replaying) {
          var r = s * 0.16;
          ctx.fillRect(s / 2 - r, s / 2 - r, r * 2, r * 2);
        } else {
          ctx.beginPath();
          ctx.moveTo(s * 0.38, s * 0.30);
          ctx.lineTo(s * 0.70, s * 0.50);
          ctx.lineTo(s * 0.38, s * 0.70);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    MouseArea {
      anchors.fill: parent
      onClicked: host.toggleReplay()
    }
  }

  // Real-status overlays: HOLD / IN FLIGHT from the API, top-left so they
  // never collide with the scene's own centred titles.
  Text {
    visible: host.sceneOverride === "hold" || host.sceneOverride === "flight"
    anchors.top: parent.top
    anchors.topMargin: 10
    anchors.left: parent.left
    anchors.leftMargin: 10
    text: host.sceneOverride === "hold" ? "HOLD" : "IN FLIGHT"
    color: "#ffe2b0"
    font.pixelSize: 15
    font.bold: true
    font.letterSpacing: 2
    style: Text.Outline
    styleColor: "black"
  }

  // Replay progress: a thin bar along the scene's bottom edge.
  Rectangle {
    visible: host.replaying
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: 3
    color: "#40ffffff"

    Rectangle {
      width: parent.width * host.replayProgress
      height: parent.height
      color: "#e6ffffff"
    }
  }
}
