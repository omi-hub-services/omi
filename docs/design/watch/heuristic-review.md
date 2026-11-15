# Watch heuristic review — OMI-092 design evidence

Reviewed source revision `661384383f3f0a9acf6051940b014bcbf0bb10a5`, branch
`task/omi-092-watch-ux`, 2026-11-12. This is a source-based review, not a browser audit.
Both implementations were read. Findings below distinguish observed code from predicted user impact.
No production files or native configuration were edited.

## Evidence boundary

- `before-repo.html` and `before-framework.html` preserve current exported page HTML.
  They require their normal SSE source to show data; they are source evidence, not screenshots.
- `before-repo-fixture.html` and `before-framework-fixture.html` are populated offline exports
  of DOM produced by the actual current scripts, with original CSS and synthetic data. They can
  be opened for capture without launching the runtime. `prepare-baselines.mjs` reproduced both
  running developer and QA as `Work/implement` in the repo renderer. These are not browser renders.
- `mockup.html` is the proposed after design, with inline CSS and synthetic data, offline and script-free.
- No before/after screenshot was captured. There is no installed Linux Chromium/Chrome/Firefox;
  Windows Edge exists but launching it returned
  `WSL ERROR: UtilBindVsockAnyPort:287: socket failed 1`.
- Browser checks at 320, 390, 480, 640, 720, 768, 1024 and 1440px, both themes, keyboard,
  200% zoom and reduced motion remain unverified. Do not substitute generated illustrations or
  source exports for screenshots. See `spec.md` for the capture protocol.

## Prioritised checklist findings

| Priority/category          | Current repo page                                                                                                                                                                                                                                                                                                                   | Current framework page                                                                                                                                                                                                        | User consequence / proposal                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 correctness, data       | `watch-tasks.ts:lifecycleStep` returns Work/Rework for every running process. `watch-workflow.ts:mapTemplatePos` maps Work to `workStepId`, normally the last developer step. Analyst completion is inferred from lifecycle position. `parsePromptText` keeps skills/rules but no step identity.                                    | `read-watch-snapshot.ts` uses runtime step statuses and pinned workflow, a sounder source. It selects the first attention step and may fall back to another running attempt for `who`, which needs care for concurrent steps. | QA/reviewer/analyst can appear as implement in the repo page. Carry explicit step ID + provenance per attempt; no process-exists ⇒ implement inference. Unknown is a visible condition. Never imply success from list position alone.             |
| P0 accessibility, keyboard | `templateFlow` gives SVG groups `role=button` and `tabindex=0`, but only assigns `onclick`; no Enter/Space handling. Render replaces the DOM every second, including selected/focused nodes. No skip link or explicit focus style.                                                                                                  | No interactive diagram, avoiding the fake-button problem, but no skip link; long repeated detail list makes navigation burdensome.                                                                                            | Repo controls advertise keyboard behavior they do not implement; polling risks focus loss. Use noninteractive semantic ordered nodes and native details, stable keyed updates, visible focus, skip link.                                          |
| P1 accessibility, contrast | Light theme muted `#6a737d` on white is about 4.8:1, but on page `#f6f7f9` about 4.5:1 (borderline). `.card.stale {opacity:.55}` reduces all text contrast. `.n.cur text` is white on `#2f81f7`, about 3.7:1, below normal-text AA; SVG text is 11px. Green/white combinations and orange blocked labels also need contrast checks. | Body palette is readable, but blocked, waiting-po and failed share orange border styling. No light theme.                                                                                                                     | Replace filled status text with contrasting text on surfaces; stale becomes an explicit label with observation age, never reduced opacity. Calculate both palettes; verify actual browser computed colors later.                                  |
| P1 hierarchy               | Plan Key and task title are tiny single-line text; title is ellipsized. A larger “Workflow” heading dominates. PR, step, role, cycle, PID, turns, action, skills and rule comparisons compete in one dense card.                                                                                                                    | Large Issue/title header, run status, worker and diagram followed by a complete second node list with skills/rules. No explicit “Next” line.                                                                                  | Hard to answer where/owner/wait/next at a glance. Put Key/title first, state badge, current step/owner, compact template path, wait/next, then PR evidence. Context details are secondary disclosure.                                             |
| P1 charts/state encoding   | Diagram has current fill, dashed warnings, orange Blocked and FAIL badge; useful text exists but no on-page explanatory legend. Waiting PO and Blocked can share a blocked visual. Generic fallback uses Start/Work/Verify-PR rather than template names.                                                                           | Node state is printed, a positive text alternative; repeated SVG+list is costly. Gates and roles are small SVG sublabels; diagram accessible name is generic.                                                                 | Preserve text state labels and explicit template/gate IDs; provide one ordered diagram with text statuses and a legend. Distinguish work/rework, dependency hold and PO decision; escalation is a separate branch, not an ordinary workflow step. |
| P1 small-window density    | 13px body, 12px metadata, 9px SVG sublabels; a 540-unit diagram shrinks with its viewport. `.meta` and `.action` truncate. Overflow-x hidden can conceal overflow rather than solve it. Four template nodes per row create a long row-return connector.                                                                             | 2rem body margin consumes 64px of width. 800-unit SVG shrinks 12px text to roughly 4px at a 320px viewport. Fixed four-column drawing, then flex-wrapped duplicate list.                                                      | Phone/app windows become hard to read. Use 16px body, 14px metadata, native text wrapping and responsive ordered nodes; no horizontal clipping. Gates may increase height; accept vertical scroll and keep details collapsed.                     |
| P1 data coverage           | Repo has PR/check information and WSL quota/workers, but step attribution is coarse.                                                                                                                                                                                                                                                | `watch-snapshot.ts` has no quota or PR/check/verdict fields; worker `who` is singular. Hold reason is often a kind or blocker summary rather than a concrete decision request.                                                | A CSS-only change cannot deliver AC-2/3. Extend the shared contract/reader and use one shared data pipeline; absent fields read “unknown/not recorded”, never PASS/0%.                                                                            |
| P2 consistency             | Existing light/dark themes and system fonts are a good foundation. Different warning styles, packed typography and tiny headings weaken rhythm.                                                                                                                                                                                     | Dark-only styling differs from the repo page; separate implementations drift.                                                                                                                                                 | One token set, one card anatomy, one renderer owned by framework. Repo only supplies data/launch configuration.                                                                                                                                   |
| P2 interaction             | Probe button offers a paid quota call and confirmation. This is an existing repo endpoint, not a proposed feature.                                                                                                                                                                                                                  | Read-only GET endpoints only.                                                                                                                                                                                                 | Do not carry the repo POST /probe route/control into the common page. Preserve automatic permitted quota reads/backoff without exposing any action endpoint.                                                                                      |
| P2 performance/motion      | Full render every second; repeated event assignment and focus replacement. No decorative motion.                                                                                                                                                                                                                                    | Full DOM replacement per SSE update; duplicate representations increase DOM size. No decorative motion.                                                                                                                       | Patch stable card nodes; elapsed text can update independently without moving focus. Announce connection/error transitions, not a whole board every second. No animation needed.                                                                  |
| P2 freshness/errors        | Repo displays loading/unavailable, stale readings and reconnect status, but dimming and clipped error notes can hide the reason.                                                                                                                                                                                                    | Shows unavailable/reconnecting and retains existing DOM after failed snapshot. Board-unavailable appears in connection text.                                                                                                  | Show last-good timestamp, source unavailable and stale independently. Retain known cards and disclose freshness; unknown totals must not masquerade as zero.                                                                                      |
| P3 forms/navigation/media  | No forms or media; SVG nodes are the only detail navigation and lack keyboard activation.                                                                                                                                                                                                                                           | No forms or media; mostly static observation.                                                                                                                                                                                 | Native details + skip link suffice. No new actions, filters, drag gestures, imagery, external fonts or charts libraries. Form validation, image loading and destructive-action undo are not applicable.                                           |

The security baseline is strong in both renderers: DOM creation/textContent, hash-based CSP,
no external assets, loopback binding and Host/Origin checks. Repo `watch-web.ts` additionally
has POST /probe; framework `watch-server.ts` allows GET only. The common design adopts the
framework's read-only boundary. Keep security tests and hostile text fixtures.

## Design response and remaining checks

Latest PO anatomy supersedes the earlier response below: each card now has a one-line ellipsised
header, SVG-only diagram body, one-line worker footer and default-closed “Skills & rules” toggle.
Full title recovery in the closed panel is expressly requested. Forward arrows, curved/count-labelled
rework arrows and review-to-Architect/Ask PO branches replace the prior plain rail. Quota is one
vertical tool-sorted list: three actual sample profiles plus two clearly marked future-row previews.
No visible context block, next-action row or PR/evidence chips remain. All 162 token pairs still pass.
The remaining source-review findings above are unchanged; browser observations are still pending.

The paragraphs below record the preceding design responses, not the latest card anatomy.

PO feedback on the first proposal identified an additional P1 issue: the 720px single-column layout
wasted desktop width and required excessive scrolling; mainly neutral surfaces made state differences
too subdued. The revised proposal prioritises a full-width desktop board: 3 columns at 1360px and
above, 2 at 900–1359px, 1 below 900px. Quota is one top strip; details remain collapsed. Nine cards
form three rows on 1440/1920px screens, rather than nine full-width rows. The 1920×1080 one-screen
fit and 1440×900 small-overflow target are height budgets, not browser-observed results.

`mockup.html` makes the current step bold and outlines the current ordered node. Desktop rails
remain horizontal; only narrow layouts wrap. Every state has text and a supplementary symbol.
Tinted headers, coloured state borders and badges distinguish blue Work, orange Rework, amber
Waiting PO, red Blocked, violet Architect, magenta Ask PO, green Done, crimson Failed and slate
Unknown. Separate role underlines distinguish analyst/developer/QA-designer/reviewer/architect.
Checks/verdict chips and quota bars carry semantic colour plus explicit text. All 162 calculated
text/boundary pairs pass their declared thresholds; actual rendering is still unverified.

Plan Key and the sole complete title share the header; fixture titles wrap within two lines without
clipping or a second title copy. Model/effort, loaded skills and rules are visible as three highlighted
groups; +N disclosures list overflow only. Missing/unknown context is explicit. Worker role/tool/profile and compact
wait/next lines remain visible. Review after FAIL has a compact return path and expanded history.
The feature rail retains scope-approved and ready-to-merge; ui-ux retains every cost/evidence/merge
gate with visible abbreviation definitions and full accessible labels/details. UI-UX verify remains
designer, while the QA fixture uses feature. The palette, breakpoint and accessibility sections in
`spec.md` supersede the original narrow-window proposal.

This response is a proposed design, not a claim that visual quality has been observed.
Before design approval: capture both current pages with synthetic data and the mockup at the
same dimensions; inspect typography/wrapping/contrast in both themes; navigate disclosures
using Tab/Shift+Tab/Enter/Space; record the PO decision outside this artifact in the runtime.
