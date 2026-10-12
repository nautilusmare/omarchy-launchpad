import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Launchpad — a simple SpaceX launch tracker. Bar shows a rocket icon, plus a
// live countdown only in the last hour before launch; the panel shows an
// animated launch scene, the mission, pad times, and a watch link (with a play
// button that replays the whole launch sequence in ~35 seconds);
// notifications fire a day, an hour, and ten minutes out, plus when a launch
// is scrubbed or rescheduled.
//
// All notification decisions live in Model.planNotifications (pure, tested),
// which diff the freshly fetched launches against the persisted state file.
Panel {
  id: root
  moduleName: "maurice.spacex"
  ipcTarget: "maurice.spacex"
  manageIpc: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/maurice.spacex/"
  readonly property string statePath: stateDir + "state.json"
  readonly property string notifyBin: Quickshell.env("OMARCHY_NOTIFY_BIN") || "/usr/bin/omarchy-notification-send"
  // The bar's drawn at 26px with 12px text; a 14px mark sits on the same
  // optical line as the glyph it replaces.
  readonly property real iconSize: 14

  function diagnostic() {
    var nextName = root.next ? root.next.mission : ""
    var recs = root.launches ? root.launches.length : -1
    return "launches=" + recs + " next=" + nextName
      + " stateReady=" + root.stateReady
      + " fetchedAt=" + Math.round(root.fetchedAt)
      + " stale=" + root.stale
      + " inFlight=" + root.inFlight
      + " queued=" + (root.queuedRecords !== null)
      + " stateTextLen=" + stateFile.text().length
  }

  // ---- settings ----
  readonly property int refreshMinutes: Math.max(5, Math.min(180, Number(setting("refreshMinutes", 30)) || 30))
  readonly property var notifySettings: ({
    notify24h: setting("notify24h", true) !== false,
    notify1h: setting("notify1h", true) !== false,
    notify10m: setting("notify10m", true) !== false,
    notifyChanges: setting("notifyChanges", true) !== false
  })

  // ---- state ----
  property var launches: []
  property double nowMs: Date.now()
  property var stateObj: Model.emptyState()
  property bool stateReady: false
  property var queuedRecords: null
  property double fetchedAt: 0
  property bool stale: false
  property bool inFlight: false
  property bool flashing: false
  property int flashTicks: 0
  // Wall clock captured when a real hold starts; the panel countdown and the
  // scene freeze there until the hold releases.
  property double holdFreezeMs: 0

  // Real-status scene truth (Model.sceneOverride): "hold" | "flight" | "".
  readonly property string sceneOverride: Model.sceneOverride(root.next)
  readonly property bool holdActive: root.sceneOverride === "hold"

  onHoldActiveChanged: {
    if (root.holdActive) root.holdFreezeMs = root.nowMs
  }

  // Within half an hour of a precise T-0, poll every 4 minutes so holds,
  // slips and liftoffs surface quickly. 30min/4min ≈ 8 calls in the window
  // plus the base tick — comfortably inside the 15/hour free quota.
  readonly property bool nearT0: root.next !== null && root.next.precise
    && (root.next.netMs - root.nowMs) < 30 * 60000
    && (root.next.netMs - root.nowMs) > -Model.LIFTOFF_GRACE_MS

  // Night-launch badge: the sky phase at the pad at T-0, reused from the
  // scene's own daylight source. Text-only, no emoji-font dependency.
  readonly property string skyBadge: (function () {
    if (root.next === null || !isFinite(root.next.netMs)) return ""
    var ph = Model.skyPhaseFor(root.next.netMs, root.next.padLat, root.next.padLng)
    if (ph === "night" || ph === "deep") return "NIGHT LAUNCH"
    if (ph === "golden" || ph === "twilight" || ph === "dusk") return "SUNSET LAUNCH"
    return ""
  })()

  // Post-launch recap: once the API reports Success/Failure, the countdown
  // block becomes a result card for the rest of the grace window.
  readonly property bool recapActive: root.next !== null
    && /^(success|failure)$/i.test(root.next.statusAbbrev || "")
  readonly property bool recapSuccess: root.recapActive
    && /^success$/i.test(root.next.statusAbbrev || "")

  // Auto-advances to the next launch once one passes its grace window.
  readonly property var next: Model.pickNext(root.launches, root.nowMs)
  // Mission personality: noteworthy flights (crew, Starship, Heavy) turn the
  // bar urgent a day out instead of an hour; routine runs keep the hour.
  // The classification rides along on the record (rec.flags), computed once
  // per fetch — never re-run per tick.
  readonly property var missionClass: (root.next && root.next.flags) ? root.next.flags : null
  readonly property bool noteworthy: root.missionClass !== null && root.missionClass.noteworthy
  readonly property string missionTag: (function () {
    if (root.missionClass === null) return ""
    if (root.missionClass.crew) return "CREWED"
    if (root.missionClass.starship) return "STARSHIP"
    if (root.missionClass.heavy) return "FALCON HEAVY"
    return ""
  })()
  readonly property bool urgentNow: root.next !== null && root.next.precise
    && root.next.netMs - root.nowMs <= (root.noteworthy ? 86400000 : 3600000)
    && root.next.netMs - root.nowMs > -Model.LIFTOFF_GRACE_MS
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- bar surface ----
  visible: root.next !== null
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // ---- notifications ----
  function flashCall() {
    if (flashTimer.running) return
    root.flashTicks = 0
    flashTimer.start()
  }

  function notifyEvent(ev) {
    var content = Model.notificationContent(ev)
    var argv = [
      root.notifyBin,
      "--app-name", "Launchpad",
      "-u", content.urgency,
      "-g", content.glyph,
      "-r", String(Model.replaceId(ev.launch.id, ev.kind)),
      content.title,
      content.body
    ]
    Util.execArgv(argv)
  }

  // Plan once state is loaded, so a race between the first fetch and the
  // state file can never re-fire an alert the user already saw.
  function planAndSave() {
    if (!root.stateReady) return
    var records = root.queuedRecords !== null ? root.queuedRecords : root.launches
    if (!records || !records.length) return
    var plan = Model.planNotifications(records, root.stateObj, root.nowMs)
    var events = Model.filterEvents(plan.events, root.notifySettings)
    for (var i = 0; i < events.length; i++) {
      root.notifyEvent(events[i])
      if (events[i].kind === "t24" || events[i].kind === "t1" || events[i].kind === "t10") continue
      // Routine Starlink progress (go/liftoff) stays quiet; problems on any
      // vehicle still flash the bar.
      var lk = events[i].kind
      if ((lk === "go" || lk === "liftoff") && events[i].launch
        && Model.classifyMission(events[i].launch.mission, events[i].launch.vehicle).starlink) continue
      root.flashCall()
    }
    root.stateObj = plan.state
    stateFile.setText(Model.serializeState(plan.state))
    root.queuedRecords = null
  }

  function applyRecords(records) {
    root.launches = records
    root.stale = records.length === 0
    root.fetchedAt = Date.now()
    root.inFlight = false
    root.planAndSave()
  }

  function fetchNow() {
    if (root.inFlight) return
    root.inFlight = true
    fetchUpcoming.running = true
  }

  function refreshNow() {
    root.fetchNow()
  }

  function refresh() {
    root.fetchNow()
  }

  function watch() {
    var url = root.next ? String(root.next.webcastUrl || "") : ""
    if (url === "") return
    Util.execArgv(["xdg-open", url])
  }

  // A replay needs a visible scene: open the panel first when closed. The
  // frame loop starts on its settle timer; the 250ms offset into the 38s
  // replay is negligible.
  function replay() {
    if (!root.opened) root.open()
    scene.toggleReplay()
  }

  // ---- IPC ----
  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function watch(): string { root.watch(); return "ok" }
    function replay(): string { root.replay(); return "ok" }
    function status(): string { return root.diagnostic() }
  }

  // ---- click handling ----
  function barPressed(buttonCode) {
    if (buttonCode === Qt.RightButton) root.watch()
    else if (buttonCode === Qt.MiddleButton) root.refreshNow()
    else root.toggle()
  }

  // Middle-click in the panel means the same as middle-click in the bar.
  function panelPressed(buttonCode) {
    if (buttonCode === Qt.LeftButton) root.watch()
    else if (buttonCode === Qt.MiddleButton) root.refreshNow()
  }

  onOpenedChanged: {
    if (!root.opened) return
    root.nowMs = Date.now()
    if (root.stale) root.refreshNow()
    Qt.callLater(function() { if (root.opened) keyCatcher.forceActiveFocus() })
  }

  // The countdown ticks from this single source of time so every text binding
  // stays cheap and consistent.
  Timer {
    id: tickTimer
    interval: 1000
    repeat: true
    running: true
    onTriggered: root.nowMs = Date.now()
  }

  Timer {
    id: refreshTimer
    interval: root.nearT0 ? 4 * 60000 : root.refreshMinutes * 60000
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshNow()
  }

  Timer {
    id: flashTimer
    interval: 150
    repeat: true
    onTriggered: {
      root.flashTicks++
      root.flashing = !root.flashing
      if (root.flashTicks >= 6) {
        root.flashing = false
        root.flashTicks = 0
        stop()
      }
    }
  }

  Component.onCompleted: {
    ensureDirs.running = true
  }

  Process {
    id: ensureDirs
    command: ["mkdir", "-p", root.stateDir]
    onExited: stateFile.reload()
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.stateObj = Model.parseState(text())
      root.stateReady = true
      root.planAndSave()
      root.fetchNow()
    }
    onLoadFailed: {
      root.stateObj = Model.emptyState()
      root.stateReady = true
      root.planAndSave()
      root.fetchNow()
    }
  }

  Process {
    id: fetchUpcoming
    command: ["curl", "-fsS", "--max-time", "20", "-A", Model.USER_AGENT, Model.upcomingUrl(Model.UPCOMING_LIMIT)]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var raw = String(text || "").trim()
        var records = Model.parseUpcoming(raw)
        if (records.length === 0) {
          // Network or API trouble: keep showing what we have, dimmed.
          root.stale = true
          root.inFlight = false
          return
        }
        root.queuedRecords = records
        root.applyRecords(records)
      }
    }
    onExited: function(exitCode, exitStatus) {
      root.inFlight = false
      if (exitCode !== 0) root.stale = true
    }
  }

  // The countdown's advance width, so the bar slot can be sized to fit the
  // mark and the text as one centred group.
  TextMetrics {
    id: countFont
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: root.barLabel()
  }

  // Mark, gap, countdown: the same three pieces the old glyph-plus-text label
  // was built from, with the mark now drawn instead of borrowed from a font.
  readonly property real iconGap: 5

  // Happening-now state: a launch within ±15 minutes of its precise T-0,
  // or already climbing. The bar gains a blinking dot (driven by the 1s
  // clock tick — no extra timer).
  readonly property bool happeningNow: root.next !== null && (root.sceneOverride === "flight"
    || root.next.webcastLive === true
    || (root.next.precise && Math.abs(root.next.netMs - root.nowMs) <= 15 * 60000))

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The label is empty because the contents are drawn below; WidgetButton
    // still provides the slot, the theme, the tooltip and the clicks.
    text: ""
    labelVisible: false
    hasVisualContent: true
    horizontalMargin: 8
    fixedWidth: barGroup.contentWidth + button.horizontalMargin * 2
    active: root.urgentNow || root.flashing
    dimmed: root.stale && !root.urgentNow
    tooltipText: root.tooltip
    onPressed: function(buttonCode) { root.barPressed(buttonCode) }

    Item {
      id: barGroup
      // Named apart from Item's own implicitWidth so the parent can size
      // itself from it before any layout has run.
      readonly property real contentWidth: barX.width
        + (barCountdown.text !== "" ? root.iconGap + barCountdown.implicitWidth : 0)
        + (root.happeningNow ? root.iconGap + liveDot.dotSize : 0)

      anchors.centerIn: parent
      width: barGroup.contentWidth
      implicitHeight: barCountdown.implicitHeight

      RocketMark {
        id: barX
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: -0.5
        size: root.iconSize
        color: (root.urgentNow || root.flashing) ? root.urgent : root.foreground
      }

      Text {
        id: barCountdown
        x: barX.width + (root.barLabel() !== "" ? root.iconGap : 0)
        anchors.verticalCenter: parent.verticalCenter
        text: root.barLabel()
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        color: (root.urgentNow || root.flashing) ? root.urgent : root.foreground
        renderType: Text.NativeRendering
      }

      // Blinking "happening now" dot after the countdown (or the rocket when
      // the countdown is hidden). Blinks on the 1s clock, costs nothing.
      Rectangle {
        id: liveDot
        readonly property real dotSize: 6
        width: dotSize
        height: dotSize
        radius: dotSize / 2
        visible: root.happeningNow
        color: root.urgent
        opacity: Math.floor(root.nowMs / 1000) % 2 === 0 ? 1 : 0.3
        anchors.verticalCenter: parent.verticalCenter
        x: barX.width
          + (root.barLabel() !== "" ? root.iconGap + barCountdown.implicitWidth : 0)
          + (root.happeningNow ? root.iconGap : 0)
      }
    }
  }

  function barLabel() {
    if (root.next === null) return ""
    return Model.formatBarCountdown(root.next,
      root.holdActive && root.holdFreezeMs > 0 ? root.holdFreezeMs : root.nowMs)
  }

  readonly property string tooltip: root.next !== null
    ? Model.summaryText(root.next, root.nowMs)
    : "No upcoming SpaceX launches"

  // ---- panel ----
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // Cap sized so the whole content fits without scrolling on a normal
    // display (scene + rows + two-up facts + watch + week strip + footer);
    // the screen-size clamp inside fittedContentHeight still protects small
    // outputs, where scrolling remains the correct fallback.
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(800))
    // No card padding: the launch scene goes full-bleed to the panel border
    // (hero style) and the text content below restores its own padding.
    padding: 0

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onActivateRequested: root.watch()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshNow()
        else if (t === "p" || t === "P") root.replay()
        else if (t === "w" || t === "W" || t === "\r" || t === "\n") root.watch()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(14)
          opacity: root.opened ? 1 : 0

          Behavior on opacity {
            NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
          }

          // ---------- Launch scene ----------
          LaunchSceneCanvas {
            id: scene
            width: parent.width
            height: Style.space(200)
            active: root.opened
            nowMs: root.nowMs
            netMs: root.next ? root.next.netMs : NaN
            daylight: root.next ? Model.skyPhaseValue(Model.skyPhaseFor(root.next.netMs,
                root.next.padLat, root.next.padLng)) : 0
            landingResult: /success|go/i.test(root.next ? root.next.statusName : "") ? "success"
              : "fail"
            sceneOverride: root.sceneOverride
          }

          // Everything below the scene keeps the panel padding the scene
          // itself now skips: full-bleed hero on top, padded content below.
          // (Children keep their original indentation; QML does not care.)
          Item {
            width: parent.width
            implicitHeight: padded.implicitHeight + Style.space(14)

            Column {
              id: padded
              x: Style.space(14)
              width: parent.width - Style.space(28)
              spacing: Style.space(14)

          // ---------- Countdown ----------
          Column {
            width: parent.width
            spacing: Style.space(4)

            ElidedText {
              width: parent.width
              text: root.next ? root.next.mission : ""
              visible: root.next !== null && text !== ""
              color: root.dim
              pixelSize: Style.font.bodySmall
              bold: true
              hAlign: Text.AlignHCenter
            }

            ElidedText {
              width: parent.width
              text: root.next ? root.next.missionBlurb : ""
              visible: text !== ""
              color: root.dim
              pixelSize: Style.font.caption
              hAlign: Text.AlignHCenter
              wrap: true
              maxLines: 2
            }

            Image {
              id: patchImage
              property bool loadOk: true
              width: 48
              height: 48
              x: (parent.width - 48) / 2
              fillMode: Image.PreserveAspectFit
              source: root.next ? (root.next.patchUrl || "") : ""
              visible: loadOk && String(source) !== ""
              onStatusChanged: if (status === Image.Error) loadOk = false
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.skyBadge
              visible: text !== ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 2
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.missionTag
              visible: text !== ""
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 2
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.next ? Model.flightLine(root.next) : ""
              visible: text !== ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 2
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.recapActive
                ? (root.recapSuccess ? "MISSION SUCCESS" : "MISSION FAILURE") : ""
              visible: root.recapActive
              color: root.recapSuccess ? root.foreground : root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              id: countdownText
              textFormat: Text.PlainText
              width: parent.width
              // During a real hold the countdown freezes where the clock
              // stood instead of ticking toward a stale T-0.
              text: root.next ? Model.formatPanelCountdown(root.next,
                root.holdActive && root.holdFreezeMs > 0 ? root.holdFreezeMs : root.nowMs) : ""
              visible: text !== "" && !root.recapActive
              color: root.urgentNow ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.countdownCaption()
              visible: text !== "" && !root.recapActive
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1.2
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.goChance()
              visible: text !== "" && !root.recapActive
              color: root.next && root.next.probability < 50 ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1.2
              horizontalAlignment: Text.AlignHCenter
            }
          }

          // ---------- Facts ----------
          Column {
            width: parent.width
            spacing: Style.space(8)
            visible: root.next !== null

            InfoRow {
              width: parent.width
              label: "Pad"
              value: root.padText()
              visible: value !== ""
            }

            // The short facts share rows two-up; the pad above keeps full
            // width for its long name. Saves ~70px of panel height.
            Grid {
              id: factGrid
              width: parent.width
              columns: 2
              columnSpacing: Style.space(8)
              rowSpacing: Style.space(8)

              MiniFact { label: "Status"; value: root.statusText(); bold: true }
              MiniFact { label: "Local"; value: root.next ? Model.localLong(root.next.netMs) : "" }
              MiniFact { label: root.padTzAbbrev; value: root.padLocal; visible: root.padLocal !== "" }
              MiniFact { label: "Window"; value: root.windowText(); visible: value !== "" }
              MiniFact { label: "Orbit"; value: root.next ? (root.next.orbit || "") : ""; visible: value !== "" }
            }
          }

          // ---------- Watch ----------
          Button {
            width: parent.width
            visible: root.next !== null && String(root.next.webcastUrl || "") !== ""
            text: root.next && root.next.webcastLive === true ? "Watch live now" : "Watch launch"
            iconText: "\uf16a"
            hasCursor: false
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            verticalPadding: Style.spacing.controlPaddingY
            onClicked: root.watch()
          }

          // ---------- Week strip ----------
          Column {
            width: parent.width
            visible: root.comingUp.length > 0
            spacing: Style.space(4)

            PanelSeparator { foreground: root.foreground }

            PanelSectionHeader {
              width: parent.width
              text: "COMING UP"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Row {
              width: parent.width
              spacing: Style.space(8)

              Repeater {
                model: root.comingUp
                delegate: Column {
                  width: (parent.width - 3 * Style.space(8)) / 4
                  spacing: 2

                  ElidedText {
                    width: parent.width
                    text: Model.localDayClock(modelData.netMs)
                    color: root.dim
                    pixelSize: Style.font.caption
                  }

                  ElidedText {
                    width: parent.width
                    text: modelData.mission
                    color: root.foreground
                    pixelSize: Style.font.bodySmall
                  }
                }
              }
            }
          }

          ElidedText {
            visible: text !== ""
            width: parent.width
            topPad: Style.space(4)
            text: root.footerText()
            color: root.dim
            pixelSize: Style.font.caption
            hAlign: Text.AlignHCenter
          }
            } // padded content column
          } // padded content wrapper
        }
      }
    }
  }

  function countdownCaption() {
    if (root.next === null) return ""
    if (root.holdActive) return "HOLD"
    var wc = Model.windowCaption(root.next, root.nowMs)
    if (wc !== "") return wc
    if (!root.next.precise) return "NET · APPROXIMATE DATE"
    var remaining = root.next.netMs - root.nowMs
    if (remaining <= 0) return "LIFTOFF"
    return "T-MINUS TO LIFTOFF"
  }

  // Launch-weather chance, promoted next to the countdown when the launch
  // is under a day out and the API actually reports a number.
  // The next up-to-four launches after `next`, for the week strip.
  readonly property var comingUp: (function () {
    var out = []
    for (var i = 0; i < root.launches.length && out.length < 4; i++) {
      var rec = root.launches[i]
      if (root.next && rec.id === root.next.id) continue
      if (rec && rec.netMs > root.nowMs) out.push(rec)
    }
    return out
  })()

  function goChance() {
    if (root.next === null || root.next.probability < 0) return ""
    var remaining = root.next.netMs - root.nowMs
    if (remaining <= 0 || remaining > 86400000) return ""
    return root.next.probability + "% GO"
  }

  function padText() {    if (root.next === null) return ""
    var parts = []
    if (root.next.padName !== "") parts.push(root.next.padName)
    if (root.next.locationName !== "") parts.push(root.next.locationName)
    return parts.join(" · ")
  }

  readonly property string padTzAbbrev: root.next ? (Model.tzAbbrev(root.next.netMs, root.next.timezone) || "Pad time") : "Pad time"
  readonly property string padLocal: (function () {
    if (root.next === null || root.next.timezone === "") return "";
    var t = Model.formatInZone(root.next.netMs, root.next.timezone);
    return t !== "" ? t + " local" : "";
  })()

  // Real status plus probability, when Launch Library gives one.
  function statusText() {
    if (root.next === null) return ""
    var label = Model.statusLabel(root.next)
    if (root.next.probability >= 0) label += " · " + root.next.probability + "%"
    return label
  }

  function windowText() {
    if (root.next === null) return ""
    var start = Model.localClock(root.next.windowStartMs)
    var end = Model.localClock(root.next.windowEndMs)
    if (isFinite(root.next.windowStartMs) && isFinite(root.next.windowEndMs)) {
      return start + " – " + end
    }
    if (isFinite(root.next.windowStartMs)) return "opens " + start
    return ""
  }

  function footerText() {
    if (root.stale) return "stale · r to refresh"
    if (root.fetchedAt <= 0) return "r to refresh"
    return "r refresh · w watch · p replay · updated " + Model.localClock(root.fetchedAt)
  }

  component InfoRow: Item {    id: infoRow
    property string label: ""
    property string value: ""
    property bool emphasized: false

    implicitHeight: Math.max(valueLabel.implicitHeight, valueText.implicitHeight) + Style.spacing.sm

    Text {
      id: valueLabel
      textFormat: Text.PlainText
      text: infoRow.label
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
    }

    ElidedText {
      id: valueText
      anchors.left: valueLabel.right
      anchors.leftMargin: Style.space(12)
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: infoRow.value
      color: root.foreground
      pixelSize: Style.font.bodySmall
      bold: infoRow.emphasized
      hAlign: Text.AlignRight
    }
  }

  // Text that reveals its full content in a tooltip whenever it is actually
  // elided (Text.truncated). Hover-only: acceptedButtons NoButton keeps
  // clicks and flick gestures untouched.
  component ElidedText: Item {
    id: tipText
    property string text: ""
    property color color: root.foreground
    property real pixelSize: Style.font.bodySmall
    property bool bold: false
    property int hAlign: Text.AlignLeft
    property int maxLines: 1
    property bool wrap: false
    property real letterSpacing: 0
    property real topPad: 0

    implicitHeight: tipLabel.implicitHeight + tipText.topPad

    Text {
      id: tipLabel
      textFormat: Text.PlainText
      width: parent.width
      y: tipText.topPad
      text: tipText.text
      color: tipText.color
      font.family: root.fontFamily
      font.pixelSize: tipText.pixelSize
      font.bold: tipText.bold
      font.letterSpacing: tipText.letterSpacing
      horizontalAlignment: tipText.hAlign
      wrapMode: tipText.wrap ? Text.WordWrap : Text.NoWrap
      maximumLineCount: tipText.maxLines
      elide: Text.ElideRight
    }

    MouseArea {
      id: tipHover
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.NoButton
    }

    PanelToolTip {
      visible: tipHover.containsMouse && tipLabel.truncated
      text: tipText.text
      fontFamily: root.fontFamily
    }
  }

  // Half-width fact cell for the two-up facts grid: dim label over the value.
  component MiniFact: Column {    id: miniFact
    property string label: ""
    property string value: ""
    property bool bold: false

    width: (factGrid.width - factGrid.columnSpacing) / 2
    spacing: 1

    Text {
      textFormat: Text.PlainText
      width: parent.width
      text: miniFact.label
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    ElidedText {
      width: parent.width
      text: miniFact.value
      color: root.foreground
      pixelSize: Style.font.bodySmall
      bold: miniFact.bold
    }
  }
}