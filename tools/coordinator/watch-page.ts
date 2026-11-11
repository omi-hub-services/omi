// The single page served by watch-web.ts (OMI-067): inline CSS and JS, nothing loaded from
// outside. The script builds the DOM with createElement/textContent only; external strings
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
function renderWorkers(s, since) {
  var box = el("section");
  box.appendChild(heading("Workers"));
  var w = s.workers;
  if (w.state === "loading") box.appendChild(el("div", "note", "Loading…"));
  else if (w.state === "unavailable")
    box.appendChild(el("div", "note err", "WSL unavailable: " + w.reason + " (retrying)"));
  else if (w.items.length === 0) box.appendChild(el("div", "note", "(none)"));
  else
    w.items.forEach(function (p) {
      var card = el("div", "card " + (p.tone === "normal" ? "" : p.tone));
      var top = el("div", "row");
      top.appendChild(el("span", "title", p.task));
      top.appendChild(el("span", "meta", p.tool + " " + p.profile));
      top.appendChild(el("span", "spacer"));
      top.appendChild(el("span", "meta", dur(p.elapsedSeconds + since)));
      card.appendChild(top);
      card.appendChild(
        el(
          "div",
          "meta",
          p.model + " " + p.effort + " · turn " + (p.turns === null ? "?" : p.turns) + " · pid " + p.pid,
        ),
      );
      var action = el("div", "action", "→ " + p.lastAction);
      action.title = p.lastAction;
      card.appendChild(action);
      box.appendChild(card);
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
  app.replaceChildren(renderWorkers(snap, since), renderQuota(snap, since), renderFooter(snap));
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
