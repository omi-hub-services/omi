# Watch design specification — PO layout revision

Design artifacts only, source baseline 661384383f3f0a9acf6051940b014bcbf0bb10a5, branch
task/omi-092-watch-ux. This anatomy supersedes the previous visible execution-context block.
The shared framework ownership and security implementation map below remain unchanged.

## Card anatomy — exactly three parts and one toggle

1. **Header:** one horizontal line, Plan Key + title. Title uses white-space:nowrap and
   text-overflow:ellipsis. The h3 retains its full DOM text as the article accessible name;
   the full title is also readable inside the closed toggle panel. There is no title tooltip,
   secondary visible title line, state badge or metadata in this header.
2. **Body:** only the inline SVG workflow diagram. Every template step is a rounded rectangle;
   every gate is a small diamond. Consecutive nodes have directed arrows. Node colour and a tiny
   symbol encode state. No separate worker, current-step, next-action, PR/check/verdict or context row.
3. **Footer:** one line: role · step · tool/profile · model/effort · elapsed. Active samples use the actual
   step/branch identity. Idle samples show only no worker · Waiting PO/Blocked/Ask PO. Tool/profile
   stays on this line without an extra row. Long footer text retains a single line with local horizontal
   overflow rather than clipping facts; normal 1920/1440 fixtures fit the line by design.
4. **Native toggle:** summary “Skills & rules”, collapsed by default. Contains the accessible full
   title and only running-worker skills/rules as chips. ◆ marks mandatory rules, ○ step-only
   guidance; the shared legend explains symbols. No running worker means unavailable loaded set,
   never a fabricated loaded context. QA demonstrates an unexpected loaded skill and a named missing
   expected skill. No nested +N toggles are needed: this panel already holds all context.

The duplicate full title inside a default-closed panel is intentionally restored by this PO request;
only the header title is visible while the panel is closed. The diagram and footer repeat the current
step only in the two locations expressly requested. No old standalone current-step or owner row remains.
The former PR/check/verdict chips, next-action line, visible context block and repeated evidence
sentences are removed. Diagram quality states express the relevant review failure/current status.
Do not infer a current-head verdict from a historical failure loop.

## Diagram geometry and state

SVG viewBox width is 600. Native text, vector paths and CSS tokens only; no raster assets or scripts.
Steps are 88 units wide; gates are 26-unit diamonds; consecutive node gaps are 18 units. Full IDs
and node states are included in the SVG accessible name in template order. Visual abbreviations are
defined once in the page legend: Build = implement, Scope = scope-approved, Merge = ready-to-merge,
D/V/R = design/verify/review, cost = approved-cost gate, ev = evidence gate. UI-UX retains all nine
cost/evidence/step/merge nodes; feature retains all six step/gate nodes. No workflow is hardcoded as
Start/Work. The actual template determines node order and shape.

| State            | Colour token      | Additional cue            |
| ---------------- | ----------------- | ------------------------- |
| Done             | done, green       | ✓                         |
| Current          | work, blue        | ▶ and thicker outline     |
| Pending          | unknown, slate    | ○                         |
| Failed           | failed, crimson   | ×                         |
| Waiting PO       | waiting, amber    | Ⅱ and dashed outline      |
| Blocked          | blocked, red      | ⊘ and dotted outline      |
| Skipped          | unknown, slate    | – and long-dashed outline |
| Architect branch | architect, violet | ! Architect               |
| Ask PO branch    | ask, magenta      | ? Ask PO                  |

The renderer supports Skipped; these pinned workflows have mandatory gates, so no fixture pretends
that a required approval/merge gate was skipped. The legend/style document the state; production
must use explicit runtime skipped data only where the template permits it.

Every connector is orthogonal: only horizontal/vertical segments with 90° elbows, plus a triangle
arrowhead. There are no curved path commands. Rework descends from the failed review node's lower
edge, turns onto a dedicated y=104 track, then rises into implement's lower edge with an upward
arrowhead. Its label is ↶ 1 / ↶ 2 / ↶ 4. The post-correction
review fixture uses a dashed historical loop labelled “↶ 1 · prior”; its current review is blue rather
than falsely failed. Active rework renders review failed and implement current.

Escalation is a separate lower branch off review: a dashed elbow route to Architect, and, when needed,
another directed segment to Ask PO. Branches are not ordinary template steps or evidence of success.
Exactly one node per card has aria-current=step, including the active Architect/Ask PO branch.
The entire SVG has role=img with a full descriptive label; child shapes are not keyboard controls.

ViewBox heights are content-aware: 94 for the straight path, 124 for a rework loop, 170 for escalation.
This avoids a large empty lower diagram area on ordinary cards while reserving space for real branches.
No text shrinking by breakpoints, overflow clipping or hidden branches is used. Actual SVG text size
after scaling, arrow clearance and clarity at 1440/1280/mobile require browser verification.

### Build-time overlap gate

The build records every rendered SVG label, line segment and arrowhead in geometry-check.json.
Labels receive explicit textLength/lengthAdjust widths and conservative declared height boxes
(20–24 viewBox units for 12–15px text). Connector segments are expanded by 3.5 viewBox units for
stroke/clearance; arrowheads use their full bounding rectangles. The same coordinates drive SVG
output and checking. Each connector/arrowhead rectangle is checked against every label rectangle
within that diagram, including template text, node symbols/names, gate captions, rework counts
and escalation labels. A deliberately crossing negative control confirms collision detection.

Counts have a dedicated surface-coloured plate: 58 units wide normally, 104 for the historical label.
The return track is split, stopping seven units outside either plate edge; no path runs behind the
count and masking alone is not treated as separation. Branches use y=96 and x=570 channels outside
gate captions, then enter Architect at y=145; Ask PO uses a separate horizontal segment. Direct
step links stay between node boundaries. Diagram positions/heights otherwise remain unchanged.

Result: **9 diagrams, 95 label boxes, 128 connector parts, 0 intersections; all segments orthogonal**.
The build throws on a non-orthogonal segment or intersection. The verifier also rejects any SVG
curve/arc path commands. This is declared layout-bounding-box evidence, not browser getBBox():
font rasterisation, user font overrides, non-scaling stroke at extreme zoom and actual screen
rendering still require browser verification. Explicit text widths and spare vertical padding reduce
font-metric variability; do not claim empirical rendered bounding boxes from this environment.

## Quota panel — vertical profiles, horizontal data per row

One panel, with rows always stacked vertically; never a flex row of separate profile cards.
Actual profiles are sorted Claude first, then Codex, alphabetical by profile within each tool.
Each row is a six-column horizontal grid:

**Tool · profile name · progress bar · 5h xx% · 7d yy% · reset hh:mm**.

Three configured synthetic profiles: Claude profile-a (16%, low), Claude profile-b (8%, critical),
Codex profile-a (72%, OK). The panel also renders two clearly marked future slots: Claude profile-c
(slot 4 preview) and Codex profile-b (slot 5 preview), in the corresponding tool groups. These rows
are placeholders, not two additional configured profiles; totals still say 3 profiles. Their bars are
unknown/hatched and values are em dashes. The preview deliberately budgets five visible rows.

The bar contains no text. Fill colour encodes OK/Low/Critical, hatching denotes Unknown; each bar
has an accessible label with severity and remaining percentage. Visible 5h/7d percentages provide
the numeric alternative. No extra visible severity badge is inserted. This follows the PO's specific
colour-only bar request while retaining screen-reader labels and adjacent quantitative information.
Sample severity is illustrative, not a change to scheduler thresholds. Five-hour remaining drives
the sample fill; production must name the window and apply the existing quota policy consistently.

Columns: 70px tool, 160–240px profile, flexible ≥100px bar, 85px 5h, 85px 7d, 115px reset; 12px gaps.
Rows have natural minimum 25px height. Long profile names may increase the name column's row height
without changing the single horizontal data layout. Below 710px the labelled, focusable quota region
scrolls horizontally locally; the page itself must not overflow. Profiles remain vertical at all widths.

## Grid and fit target

| Width               | Board                              |
| ------------------- | ---------------------------------- |
| 1920 / 1440 (≥1360) | 3 columns, 12px gaps, up to 3 rows |
| 1280 (900–1359)     | 2 columns, up to 5 rows            |
| Below 900           | 1 column; 44px toggle targets      |

Full viewport up to 1920px; 24px gutters desktop, 12px mobile. Card height is natural, with no
fixed-height viewport, internal card scrolling, truncation of diagram content or title wrapping.
At 1920×1080, a static height budget using about 600px diagram width is approximately 1040–1070px
for nine cards plus all five quota rows, header and legend with every toggle closed. Three configured
quota rows alone save around 50px. At 1440×900 the scaled diagrams lower row heights and wrapping
may introduce a small scroll. These are design calculations, **not browser-observed fit results**.
No Linux browser is installed; the earlier Windows browser invocation was blocked by a WSL socket
error. Therefore the answer to “does it fit?” is: budgeted to fit; not yet empirically verified.
Expanded skills/rules, zoom, long text and larger user fonts may increase page height by design.

## Tokens and contrast

The previous palette is retained. Background/surface/ink/secondary/border remain
light #f3f5fa/#ffffff/#182334/#485970/#78879b and
dark #101722/#192332/#edf2fa/#b7c5d8/#8392a7.

| Semantic token              | Light text / tint | Dark text / tint  |
| --------------------------- | ----------------- | ----------------- |
| Work/current/focus          | #164da1 / #eaf2ff | #9dc5ff / #182d49 |
| Rework                      | #8d3b09 / #fff1e7 | #ffc294 / #3b291b |
| Waiting PO / low quota      | #755000 / #fff6da | #f6d17b / #382f17 |
| Blocked                     | #a21b35 / #ffedf0 | #ffacba / #3c2028 |
| Architect                   | #6332a0 / #f3edff | #cbb0ff / #302344 |
| Ask PO                      | #8b276e / #fcebf6 | #f2a9dc / #38213a |
| Done / OK quota             | #16613b / #e8f6ee | #86ddb1 / #18382b |
| Failed / critical quota     | #98132c / #fce7ec | #ff9db3 / #3b1e2c |
| Pending / skipped / unknown | #485970 / #edf1f5 | #b7c5d8 / #283344 |

Node text/strokes use their semantic foreground; fills use matching tints. Gate label text is outside
its diamond on the card surface; that pairing is also checked. Worker chips use ink on surface,
the toggle uses Work tint; missing-skill text uses Failed on Work tint. All are within the existing
162 measured pairs, which remain a conservative superset (former role accents are no longer used).
All 162 pass: text ≥6.051:1, boundaries/fills ≥3.099:1. Contrast comparisons use unrounded ratios.
This is numeric token evidence, not full WCAG AA certification or observed theme rendering.

## Accessibility, security and verification

Native details is keyboard accessible with visible 3px focus, ≥24px desktop and 44px mobile target.
No custom click handlers or diagram controls. Semantic h1/h2/h3, skip link, article accessible names,
full SVG alternatives, full title recovery inside the panel, quota numeric alternatives/labels,
reduced-motion CSS and no animation. Production must preserve expanded/focused state across updates.
Verify keyboard-only access to the quota scroll region and title recovery at zoom, both themes.

No dependencies, fonts, network requests, external assets, credentials or actions. Static trusted
fixtures are generated offline. The mockup permits inline CSS for file inspection only. Production
must retain hashed CSP, textContent-only insertion, 127.0.0.1 bind, Host/Origin validation and GET-only
observation endpoints; do not copy unsafe-inline or an SVG markup-string builder for external data.
Use createElementNS/setAttribute/textContent for live SVG. No probe, approval or worker endpoints.

Update checks cover exact anatomy, arrows/loops/branches, three real fixture profiles + two slots,
current node per diagram, title recovery placement, security/static CSS and numeric contrast.
Browser screenshots, one-screen fit, keyboard and both rendered themes remain pending; no production
implementation or recorded PO approval is inferred from this packet. The broader AC remain unmet.

## Data and file implementation map (future implement step)

| Layer / existing owning file                                                                                               | Required change                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain: `src/domain/workflows/workflow-diagram.ts`                                                                         | Keep template ordering authoritative; represent actual steps/gates, rework and held node. Ensure failed past review does not mask the current rework/QA step. Handle gate hold and simultaneous attempts explicitly where supplied. Keep I/O/time outside domain.                                                                                                                                      |
| Application contract: `src/application/contracts/watch-snapshot.ts`                                                        | Extend/version the shared snapshot for quota/source/freshness, PR checks and verdict with revision, concrete hold reason, time/source provenance, and per-step workers. Current contract lacks quota/PR fields and supports only one who. Use nullable/unavailable discriminants, not fabricated defaults. Validate at the external boundary.                                                          |
| Application: `src/application/use-cases/project/read-watch-snapshot.ts`                                                    | Compose the shared observation through ports. Prefer explicit runtime attempt step IDs. A repo fallback may use validated structured log/prompt step metadata tied to the same run; conflicts/absence produce unknown with a reason. Do not use skills as a role detector or parse arbitrary issue text as instructions/approval. Avoid pairing another step's worker with the displayed current step. |
| Existing application ports / infrastructure quota adapters                                                                 | Reuse `quota-reader.ts`, `profile-quota-reader.ts`, executor quota readers and existing quota policy. Share WSL worker/quota collection, deduplication, backoff, source priority and redacted cache semantics across repo watch/status; no second browser quota poller, no credentials in snapshots. Clarify repo source bridging without installing unfinished framework runtime here.                |
| Infrastructure: `src/infrastructure/observability/watch-page.ts`                                                           | Sole production HTML/CSS/DOM renderer using the approved design; semantic node rail, stable cards, details/legend/themes, unknown/error/empty/loading and stale states. All external strings through textContent.                                                                                                                                                                                      |
| Infrastructure: `src/infrastructure/observability/watch-server.ts`                                                         | Keep 127.0.0.1 bind, exact Host/Origin checks, hashed CSP, no-store/nosniff/no-referrer, GET-only / /health /events, SSE backpressure, idle shutdown. No control endpoint, probe button or POST /probe.                                                                                                                                                                                                |
| Repo dev tooling: `tools/coordinator/watch-web.ts`, `watch-tasks.ts`, `watch-workflow.ts`, `watch-snapshot.ts`, `watch.ts` | Replace private renderer/server with shared framework entry/data contract; remove `tools/coordinator/watch-page.ts` and duplicate diagram decisions. Keep launch/config/WSL transport in tooling; source must never import tools. Keep terminal formatting if needed, using shared state rather than duplicated workflow logic.                                                                        |
| Bootstrap: existing `src/bootstrap/container.ts` / `cli.ts` where needed                                                   | Wire observation dependencies only; no new policy in composition.                                                                                                                                                                                                                                                                                                                                      |
| Coordinator-owned `.claude/skills/omi-watch/`                                                                              | Coordinator updates launcher to the common page; worker must not edit native configuration. No proposed native text is required for this design artifact.                                                                                                                                                                                                                                              |
| Tests: existing unit/domain/application, integration/observability + tooling, contract fixtures                            | Prove per-step analyst/developer/QA/reviewer attribution; unknown/ambiguous source; actual gate/hold/rework semantics; no false PASS on wrong head; quota unknown/low/stale/failure; hostile strings and CSP; foreign Host/Origin and POST denied; one renderer; focus retention after SSE updates. Browser checks remain separate if browser tooling is unavailable.                                  |

The integration is more than importing a page constant: repo and framework currently have different
SSE shapes and data sources. Adapt to the common snapshot through existing layer boundaries;
do not keep two rendering modes or make the framework depend on tools. Required schema changes
must run through existing generators. No new dependency is needed. If a genuinely new module or
guard exception is required, architecture+ADR must precede that change.

## Security

The mockup has no scripts, network fetches or assets. Its file-only CSP permits inline CSS for
offline inspection; **do not copy `unsafe-inline` into production**. Production recomputes existing
CSS/script hashes, keeps default-src none/connect-src self/frame-ancestors none/base-uri none/
form-action none and textContent DOM insertion. The mockup's static build strings are trusted
synthetic fixtures, not an implementation pattern for external text. No worker controls, approvals,
quota probes or state mutations. A page label is never an approval.

## Failure, empty and loading behavior to implement

- Initial: “Loading tasks / quota”; totals unknown, never 0 until a successful empty response.
- Empty: “No active tasks” with last successful observation; preserve profile quota separately.
- Snapshot unavailable/disconnected: keep last-good cards, prominent stale/read-only notice and
  last received timestamp; automatic reconnect. Do not announce every repeated retry.
- GitHub unavailable: keep runtime cards, mark title/PR enrichment stale; do not erase valid worker data.
- WSL unavailable/quota unknown: label Unknown, no 0% or artificial bar; expose redacted source reason.
- Worker exits: show no worker and last observed result/time, never leave a running timer active.
- Missing template: “Template unavailable”; list known runtime steps without inventing feature gates.
- Multiple/ambiguous workers: attach by explicit step identity; unresolved entries labelled unassigned.

These states are specified, not all rendered as extra fixture cards in the primary mockup.

## Capture and approval checklist — pending

No screenshot or real-browser inspection was possible in this worker environment. Available Windows
Edge invocation failed with WSL socket error; no browser/checker was installed to bypass this.
Coordinator must capture current repo + framework pages using synthetic snapshots (no real worker
logs, credentials or private task text), then mockup in both themes at the same size.
Do not start the unfinished framework runtime in this repository to obtain captures; use an isolated
fixture harness serving the existing page export, or the prepared offline fixture pages.

Save actual screenshots as `before-repo-640-light.png`, `before-framework-640-dark.png`,
`after-640-light.png`, `after-640-dark.png`, plus after 390px and 320px widths. Record viewport,
theme, browser/version and artifact hash. Also inspect 480/720/768/1024/1440px, keyboard-only,
200% zoom, reduced-motion, long titles/IDs and open details. Check document scrollWidth ≤
viewport width without clipping. Capture the review/rework, PO/blocked and escalation cards as
well as the top screen; a header-only screenshot is insufficient. Record actual observed issues.

PO design approval must be an explicit runtime-recorded decision attached to these artifacts.
AC-1 remains not met until screenshots and that decision exist. AC-2 and AC-3 remain not met
in this design-only step. Do not implement production changes before the design gate is satisfied.
