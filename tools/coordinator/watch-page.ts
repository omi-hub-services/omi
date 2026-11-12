// The single page served by watch-web.ts (OMI-067, OMI-074): inline CSS and JS, nothing loaded
// from outside. The script builds the DOM with createElement/textContent and the lifecycle
// diagram with createElementNS/setAttribute (SVG attributes are escaped by the DOM); external strings
// (task names, last actions, notes) never reach innerHTML. The CSP allows only these two inline
// blocks, by hash, and connections to the same origin.
import { createHash } from "node:crypto";

const CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --card: #ffffff; --line: #dde1e7; --text: #1b1f24; --muted: #6a737d;
  --accent: #2f81f7; --track: #e6e9ee; --warn: #b7791f; --bad: #cf222e; --ok: #1a7f37;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --card: #1c2128; --line: #30363d; --text: #e6edf3; --muted: #8b949e;
    --accent: #58a6ff; --track: #2d333b; --warn: #e3b341; --bad: #ff7b72; --ok: #3fb950;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow-x: hidden; }
body {
  background: var(--bg); color: var(--text); font: 13px/1.35 system-ui, "Segoe UI", sans-serif;
  padding: 8px 10px 10px; min-width: 0;
}
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
h1 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 10px 0 4px; }
header h1 { margin: 0; }
#conn { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--ok); }
#conn.down { color: var(--bad); border-color: var(--bad); }
.card { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: 5px 8px; margin-bottom: 5px; min-width: 0; }
.card.done { border-left-color: var(--muted); color: var(--muted); }
.card.error { border-left-color: var(--bad); }
.card.error .title { color: var(--bad); }
.card.low { border-left-color: var(--warn); }
.card.stale { opacity: .55; }
.row { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.title { font-weight: 600; white-space: nowrap; }
.meta { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.action { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.spacer { flex: 1; }
.qrow { display: flex; align-items: center; gap: 6px; margin-top: 3px; min-width: 0; }
.qlabel { width: 52px; flex: none; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track { flex: 1; height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; min-width: 40px; }
.fill { display: block; height: 100%; background: var(--accent); }
.fill.low { background: var(--warn); }
.qval { width: 128px; flex: none; text-align: right; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.err { color: var(--bad); }
.n text { font: 11px/1 system-ui, "Segoe UI", sans-serif; text-anchor: middle; dominant-baseline: central; fill: var(--muted); }
.n text.sub { font-size: 9px; font-weight: 400; }
.n rect { stroke-width: 1.5; }
.n.todo rect { fill: var(--card); stroke: var(--line); }
.n.done rect { fill: var(--ok); stroke: var(--ok); }
.n.done text, .n.cur text, .n.lit text { fill: var(--card); }
.n.cur rect { fill: var(--accent); stroke: var(--text); stroke-width: 2.5; }
.n.cur text { font-weight: 700; }
.n.lit rect { fill: var(--ok); stroke: var(--accent); stroke-width: 2.5; }
.n.warn rect { fill: var(--card); stroke: var(--warn); stroke-width: 2.5; stroke-dasharray: 4 3; }
.n.warn text { fill: var(--warn); font-weight: 700; }
.n.blocked rect { fill: var(--card); stroke: #e8710a; stroke-width: 2.5; }
.n.blocked text { fill: #e8710a; font-weight: 700; }
.n.idle rect { fill: var(--card); stroke: var(--line); stroke-dasharray: 2 3; }
.edge { stroke: var(--muted); stroke-width: 1.5; fill: none; }
.edge.dash { stroke-dasharray: 3 3; }
.edge.back { stroke: var(--bad); stroke-width: 2; }
.arrow { fill: var(--muted); }
.arrow.back { fill: var(--bad); }
.badge rect { fill: var(--bad); }
.badge text { font: 700 10px/1 system-ui, "Segoe UI", sans-serif; text-anchor: middle; dominant-baseline: central; fill: var(--card); }
.wf { font-size: 14px; font-weight: 700; margin-top: 4px; overflow-wrap: anywhere; }
svg.flow { display: block; width: 100%; height: auto; margin: 4px 0 2px; }
.step { font-weight: 600; }
.step.unknown, .warnline { color: var(--warn); }
.wrap { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
footer { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
button { font: inherit; padding: 2px 10px; border-radius: 5px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
`;

const JS = String.raw`
"use strict";
var app = document.getElementById("app");
var conn = document.getElementById("conn");
var snap = null;
var received = 0;
var confirming = false;
var probeError = "";

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function dur(total) {
  var s = Math.max(0, Math.floor(total));
  if (s >= 3600) return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
  if (s >= 60) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return s + "s";
}
function ago(seconds) {
  return seconds < 60 ? "live" : Math.floor(seconds / 60) + " min ago";
}
function pct(n) {
  return n === null || n === undefined ? "?" : Math.round(n * 10) / 10 + "%";
}
function heading(text) {
  return el("h1", "", text);
}
function bar(label, left, low, resetText) {
  var row = el("div", "qrow");
  row.appendChild(el("span", "qlabel", label));
  var track = el("span", "track");
  var fill = el("span", "fill" + (low ? " low" : ""));
  fill.style.width = (left === null ? 0 : Math.max(0, Math.min(100, left))) + "%";
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el("span", "qval", pct(left) + (resetText ? " · reset " + resetText : "")));
  return row;
}
var NS = "http://www.w3.org/2000/svg";
var POS = {
  "Start": [6, 8], "Work": [96, 8], "Verify/PR": [186, 8], "Review": [276, 8],
  "Merge": [366, 8], "Done": [456, 8], "Architect": [186, 60], "Ask PO": [366, 60],
};
var MAIN = ["Start", "Work", "Verify/PR", "Review", "Merge", "Done"];
var STATE = { done: "done", current: "cur", todo: "todo", lit: "lit", warn: "warn", idle: "idle", blocked: "blocked" };
function sv(tag, attrs, text) {
  var e = document.createElementNS(NS, tag);
  Object.keys(attrs).forEach(function (k) {
    e.setAttribute(k, String(attrs[k]));
  });
  if (text !== undefined) e.textContent = String(text);
  return e;
}
function head(svg, x, y, dx, dy, cls) {
  var pts = [x, y, x - 7 * dx - 3.5 * dy, y - 7 * dy + 3.5 * dx, x - 7 * dx + 3.5 * dy, y - 7 * dy - 3.5 * dx].join(" ");
  svg.appendChild(sv("polygon", { points: pts, "class": "arrow" + (cls ? " " + cls : "") }));
}
function edge(svg, d, cls) {
  svg.appendChild(sv("path", { d: d, "class": "edge " + cls }));
}
function flow(t) {
  var svg = sv("svg", {
    viewBox: "0 0 540 124", "class": "flow", role: "img", "aria-label": t.ariaLabel,
  });
  for (var i = 0; i < MAIN.length - 1; i++) {
    var x1 = POS[MAIN[i]][0] + 72;
    svg.appendChild(sv("line", { x1: x1, y1: 22, x2: x1 + 18, y2: 22, "class": "edge" }));
    head(svg, x1 + 18, 22, 1, 0);
  }
  var byId = {};
  t.nodes.forEach(function (n) { byId[n.id] = n; });
  if (t.rework > 0) {
    // Rework is the way back to Work: Review -> Work, through Architect once it is on the path
    if (byId["Architect"]) {
      edge(svg, "M312 36 C312 76 290 74 258 74", "back");
      head(svg, 258, 74, -1, 0, "back");
      edge(svg, "M186 74 C160 74 132 66 132 36", "back");
    } else edge(svg, "M312 36 C312 130 132 130 132 36", "back");
    head(svg, 132, 36, 0, -1, "back");
    var badge = sv("g", { "class": "badge" });
    badge.appendChild(sv("rect", { x: 188, y: 98, width: 68, height: 16, rx: 8 }));
    badge.appendChild(sv("text", { x: 222, y: 106 }, "FAIL ×" + t.rework));
    svg.appendChild(badge);
  }
  if (byId["Ask PO"]) {
    edge(svg, "M336 36 C336 74 350 74 366 74", "dash ask");
    head(svg, 366, 74, 1, 0);
  }
  t.nodes.forEach(function (n) {
    var p = POS[n.id];
    if (!p) return;
    var g = sv("g", { "class": "n " + (STATE[n.state] || "todo") });
    g.appendChild(sv("rect", { x: p[0], y: p[1], width: 72, height: 28, rx: 6 }));
    g.appendChild(sv("text", { x: p[0] + 36, y: p[1] + (n.sub ? 9 : 14) }, n.label));
    if (n.sub) g.appendChild(sv("text", { x: p[0] + 36, y: p[1] + 21, "class": "sub" }, n.sub));
    svg.appendChild(g);
  });
  return svg;
}
function cycleWarn(t) {
  var c = t.cycle;
  return c.phase === "escalate-po" || (c.phase === "architect" && !c.architectCalled);
}
function taskCard(t, since) {
  var tone = t.worker && t.worker.tone !== "normal" ? " " + t.worker.tone : "";
  var card = el("div", "card" + tone + (cycleWarn(t) ? " low" : ""));
  var top = el("div", "row");
  top.appendChild(el("span", "title", t.planKey));
  top.appendChild(el("span", "meta", "#" + (t.issue === null ? "-" : t.issue) + " · " + t.priority));
  top.appendChild(el("span", "spacer"));
  card.appendChild(top);
  var name = el("div", "action", t.title);
  name.title = t.title;
  card.appendChild(name);
  var pr = t.pr
    ? "PR #" + t.pr.number + " @" + t.pr.head + " · checks " + t.pr.checks + (t.pr.draft ? " · draft" : "")
    : "PR -";
  card.appendChild(el("div", "meta", t.status + " · " + pr));
  var stepLine = el("div", "row");
  stepLine.appendChild(el("span", "step" + (t.step === "unknown" ? " unknown" : ""), "Step: " + t.step));
  stepLine.appendChild(el("span", "meta", "Role: " + t.role));
  card.appendChild(stepLine);
  if (t.stepReason) card.appendChild(el("div", "note warnline", t.stepReason));
  if (t.blockers.length) {
    card.appendChild(el("div", "note", "Blockers: " + t.blockers.map(function (b) {
      return "#" + b.number + " (" + b.state.toLowerCase() + ")";
    }).join(", ")));
  }
  card.appendChild(el("div", "wf", "Workflow: " + t.workflow));
  card.appendChild(flow(t));
  if (t.cycleNote) card.appendChild(el("div", "note" + (cycleWarn(t) ? " warnline" : ""), "Cycle: " + t.cycleNote));
  if (t.architectReason) card.appendChild(el("div", "note", "Architect called: " + t.architectReason));
  var w = t.worker;
  if (w) {
    card.appendChild(
      el("div", "meta", w.tool + " " + w.profile + " · " + w.model + " " + w.effort + " · " + dur(w.elapsedSeconds + since) + " · turn " + (w.turns === null ? "?" : w.turns) + " · pid " + w.pid),
    );
    var action = el("div", "action", "→ " + w.lastAction);
    action.title = w.lastAction;
    card.appendChild(action);
  } else card.appendChild(el("div", "meta", "Worker: - (none running for this task)"));
  card.appendChild(
    el("div", "wrap", "Skills: " + (t.skills.length ? t.skills.join(", ") : "- (" + (t.skillsNote || "none") + ")")),
  );
  card.appendChild(el("div", "wrap", "Rules: " + (t.rules.length ? t.rules.join(", ") : "- (no prompt)")));
  return card;
}
function renderTasks(s, since) {
  var box = el("section");
  box.appendChild(heading("Tasks"));
  var t = s.tasks;
  if (t.state === "loading") box.appendChild(el("div", "note", "Loading…"));
  else if (t.state === "unavailable")
    box.appendChild(el("div", "note err", "GitHub unavailable: " + t.reason + " (retrying)"));
  else if (t.items.length === 0) box.appendChild(el("div", "note", "(none In Progress or In Review)"));
  else
    t.items.forEach(function (task) {
      box.appendChild(taskCard(task, since));
    });
  return box;
}
function renderQuota(s, since) {
  var box = el("section");
  box.appendChild(heading("Quota — left"));
  var q = s.quota;
  if (q.state === "unavailable")
    box.appendChild(el("div", "note err", "WSL unavailable: " + q.reason + " (retrying)"));
  q.profiles.forEach(function (p) {
    var r = p.reading;
    var age = r ? r.ageSeconds + since : 0;
    var stale = r !== null && age > s.staleAfterSeconds;
    var card = el("div", "card" + (r && r.low ? " low" : "") + (stale ? " stale" : ""));
    var top = el("div", "row");
    top.appendChild(el("span", "title", p.tool + " " + p.profile));
    top.appendChild(el("span", "spacer"));
    top.appendChild(el("span", "meta", r ? ago(age) : ""));
    card.appendChild(top);
    if (!r) {
      card.appendChild(el("div", "note", "? / ? — " + (p.note || "unavailable")));
    } else {
      card.appendChild(bar("5h", r.fiveHour ? r.fiveHour.left : null, r.fiveHour && r.fiveHour.low, r.fiveHour && r.fiveHour.resetText));
      card.appendChild(bar("7d", r.sevenDay ? r.sevenDay.left : null, r.sevenDay && r.sevenDay.low, r.sevenDay && r.sevenDay.resetText));
      r.models.forEach(function (m) {
        card.appendChild(bar(m.model, m.left, false, m.resetText));
      });
      if (p.note) card.appendChild(el("div", "note", p.note));
    }
    box.appendChild(card);
  });
  return box;
}
function renderFooter(s) {
  var f = el("footer");
  if (s.probing) {
    f.appendChild(el("span", "", "Probing quota…"));
  } else if (confirming) {
    f.appendChild(el("span", "", "Probe Claude quota? One Haiku call per Claude profile."));
    var yes = el("button", "", "Yes, probe");
    yes.onclick = doProbe;
    var no = el("button", "", "Cancel");
    no.onclick = function () {
      confirming = false;
      render();
    };
    f.appendChild(yes);
    f.appendChild(no);
  } else {
    var b = el("button", "", "Probe quota…");
    b.onclick = function () {
      confirming = true;
      probeError = "";
      render();
    };
    f.appendChild(b);
    f.appendChild(el("span", "", "asks before spending a call"));
  }
  if (probeError) f.appendChild(el("span", "err", probeError));
  return f;
}
function doProbe() {
  confirming = false;
  fetch("/probe", { method: "POST", headers: { "X-Omi-Watch": "1" } })
    .then(function (res) {
      probeError = res.ok ? "" : "probe refused (" + res.status + ")";
      render();
    })
    .catch(function () {
      probeError = "probe failed";
      render();
    });
  render();
}
function render() {
  if (!snap) return;
  var since = (Date.now() - received) / 1000;
  app.replaceChildren(renderTasks(snap, since), renderQuota(snap, since), renderFooter(snap));
}
function setConn(up, text) {
  conn.textContent = text;
  conn.className = up ? "" : "down";
}
var source = new EventSource("/events");
source.onopen = function () {
  setConn(true, "live");
};
source.onerror = function () {
  setConn(false, "reconnecting…");
};
source.onmessage = function (ev) {
  try {
    snap = JSON.parse(ev.data);
  } catch (e) {
    return;
  }
  received = Date.now();
  setConn(true, "live");
  render();
};
setInterval(render, 1000);
`;

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export const PAGE_CSP = [
  "default-src 'none'",
  `style-src ${sha(CSS)}`,
  `script-src ${sha(JS)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omi watch</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>omi watch</h1><span id="conn" class="down">connecting…</span></header>
<main id="app"></main>
<script>${JS}</script>
</body>
</html>
`;
