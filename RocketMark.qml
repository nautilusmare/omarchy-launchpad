import QtQuick

// A geometric rocket mark — the plugin's own icon, drawn rather than borrowed.
// Slim body with a pointed nose, outboard fins, and a round window, in the
// same pure-shapes style as the XMark it replaces (see git history). Pure
// shapes keep it crisp at any bar size, cost nothing to draw, and can be
// recoloured or scaled freely. Geometry is deliberately bold: at 14px only
// silhouettes a few pixels wide survive.
//
//   RocketMark { size: 16; color: root.foreground }
//
Item {
  id: mark

  // Side length of the square the mark is drawn inside.
  property real size: 14
  // Drawn with this colour; bar callers pass the themed foreground/urgent.
  property color color: "#cacccc"

  implicitWidth: mark.size
  implicitHeight: mark.size

  readonly property real cx: mark.size / 2
  // Body: slim capsule from bodyTop down to bodyBottom.
  readonly property real bodyW: mark.size * 0.29
  readonly property real bodyTop: mark.size * 0.22
  readonly property real bodyH: mark.size * 0.57
  readonly property real bodyBottom: mark.bodyTop + mark.bodyH
  readonly property real bodyX: mark.cx - mark.bodyW / 2

  // Body.
  Rectangle {
    x: mark.bodyX
    y: mark.bodyTop
    width: mark.bodyW
    height: mark.bodyH
    radius: mark.bodyW / 2
    color: mark.color
    antialiasing: true
  }

  // Nose: a diamond (rotated square) centred on the body's top edge. The top
  // corner reads as the tip, the side corners stay flush with the body, the
  // bottom corner hides inside the body.
  Rectangle {
    id: nose
    readonly property real s: mark.bodyW * 0.70
    width: s
    height: s
    color: mark.color
    antialiasing: true
    x: mark.cx - s / 2
    y: mark.bodyTop - s / 2
    transform: Rotation {
      origin.x: nose.s / 2
      origin.y: nose.s / 2
      angle: 45
    }
  }

  // Window: small round porthole ringed by the body, glassed with a fixed
  // dark dot (reads as a hole on dark bars, as glass on light ones).
  Rectangle {
    readonly property real d: mark.bodyW * 0.45
    width: d
    height: d
    radius: d / 2
    color: mark.color
    antialiasing: true
    x: mark.cx - d / 2
    y: mark.bodyTop + mark.bodyH * 0.30

    Rectangle {
      readonly property real inner: parent.width * 0.52
      width: inner
      height: inner
      radius: inner / 2
      color: "#0b0d10"
      anchors.centerIn: parent
    }
  }

  // Fins: short bars straddling the body's base, angled to splay outward so
  // their outer ends stick past the silhouette. Centres sit outboard of the
  // body edge — centred fins would hide entirely behind the body.
  component Fin: Rectangle {
    property real finCx: mark.cx
    property real degree: 0

    width: mark.bodyW * 1.1
    height: Math.max(1.5, mark.size * 0.13)
    radius: height / 2
    color: mark.color
    antialiasing: true

    x: finCx - width / 2
    y: mark.bodyBottom - height * 1.4

    transform: Rotation {
      origin.x: width / 2
      origin.y: height / 2
      angle: degree
    }
  }

  Fin {
    finCx: mark.cx - mark.bodyW * 0.62
    degree: -25
  }
  Fin {
    finCx: mark.cx + mark.bodyW * 0.62
    degree: 25
  }

  // Exhaust flick: a small bright dot under the body so the mark reads as
  // a rocket at a glance even at 14px.
  Rectangle {
    readonly property real d: Math.max(1.5, mark.size * 0.12)
    width: d
    height: d
    radius: d / 2
    color: mark.color
    opacity: 0.9
    antialiasing: true
    x: mark.cx - d / 2
    y: mark.bodyBottom + d * 0.3
  }
}
