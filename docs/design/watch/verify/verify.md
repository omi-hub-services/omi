# OMI-092 watch page: real-browser verification, round 2 (designer, verify step)

Revision under test: `b42dc0ecc70409018535711931307c0d815fbeef` (branch `task/omi-092-watch-ux`, clean tree).
Page: `src/infrastructure/observability/watch-page.ts`, compiled with `tsc -p tsconfig.build.json --outDir .tmp/verify2-build`.
No production file was changed. `npm run check` was not re-run (the Coordinator's script-run log on this SHA, exit 0, is the evidence).

## Method

- Browser: Microsoft Edge, headless=new, Windows, driven from WSL. UA reports `Edg/157.0.0.0`; round 1 recorded file version 157.0.4341.46 (not re-queried).
- Harness (`.tmp/verify2-*.mjs`, not committed): ports 4532 (new page), 4533 (old repo page), 4534 (old framework page). Port 4317 not used.
  Synthetic snapshot of 9 cards (running, rework, Waiting PO, Blocked, Architect, Ask PO, QA with unknown values, long ui-ux title/profile, analyst with extra/missing skills) and 4 quota rows. No real logs, tokens or task text.
- CDP is unreachable from WSL. Measurements come from a probe page that loads the real page in an iframe of exact width W
  (a `frame-ancestors 'self'` copy of the same page, hashes unchanged); images are `--screenshot`. 320 and 390 captures are a W-px iframe on a 700px window (grey area to the right).
- Dark: a fixture copy with `@media(prefers-color-scheme:dark)` rewritten to `@media all` (style hash recomputed). **OS-level dark switching was not observed.** Mockup dark uses the same rewrite.
- The iframe scrollbar takes 15px, so probe `scrollWidth` is 15px under the width; "no horizontal scroll" is judged against that.
- Before pages: `git show origin/develop:<path>` copied into `.tmp/before/` and served with synthetic data in each page's own old snapshot shape (4 cards; the old framework page uses the old `buildWorkflowDiagram`).
  The old framework page is dark-only by its own CSS; the old repo page was captured in the default light scheme.

## Evidence files

| File | Viewport | Theme | SHA256 |
| --- | --- | --- | --- |
| before-repo-640-light.png | 640x1700 | light | aba81ccbed7e7afc3382e41152da45d59fa5ccf07ddd29467f078060158980a5 |
| before-framework-640-dark.png | 640x1900 | dark (fixed) | 0146ebd098c52b5f72e6cab49c8a996829572dc0d3dd42211e50d11a50acd8e1 |
| after-320-light.png | 320 (iframe in 700x3600) | light | 7b86c011dc75ad648952afd70480a812a108cdb4ab9f23349b67f2844875e455 |
| after-320-dark.png | 320 (iframe) | dark* | dd444b915c06fb4e7fd5a9e3d9a1bd0b883ca24b789c096c44c62a12e176954e |
| after-390-light.png | 390 (iframe in 700x3300) | light | 326823cbd9ccf7bbecc4787d440d9812e4aaf28f56123f56b9e8a959a5a48821 |
| after-390-dark.png | 390 (iframe) | dark* | 726a99b3383caf17ebe1146bfc263166bef831d670502608b8a764dbef2d915b |
| after-640-light.png | 640x3000 | light | 64f737f59d720dee015429cf8e1c313ead7c6e8c3617c62e1b6f1b1e97fc41d2 |
| after-640-dark.png | 640x3000 | dark* | 8385c4dfc6c1a556bac784bd1a7853163f16160c4261a75bdf6b75648711730d |
| after-1024-light.png | 1024x1350 | light | 4f53cf5ad2f7d5dc7b7b6c0fa8a44e42ef47152ae14dbd821dd706ff5b164618 |
| after-1440-dark.png | 1440x1000 | dark* | e4a17cec0a072262d578d51ab000afe3c3acbea35fe75e727e5e734c7659fd15 |
| mockup-640-light.png | 640x2600 | light | 48b2549c419b643dee8e00e202e35bf73b3b4190dbab6f8f635b2cea91bb9563 |
| mockup-640-dark.png | 640x2600 | dark* | 09013c55a17c5b42bc2d56d349d228429262c4105a8ebdd01a546caacbd0468b |

\* dark via media-query rewrite. 12 PNGs.
The two mockup files are byte-identical to round 1 (same page, same size); the other 10 are new.

## Round-1 findings: pass / fail on b42dc0e

Measured in light and dark (identical results unless noted) at 320, 360, 390, 480, 640, 699, 700, 749, 750, 899, 900, 1024, 1359, 1360, 1440.

| # | Round-1 finding | Result |
| --- | --- | --- |
| 1 | Diagram text about 8px at 390 | **Pass at 320 / 390 / 640**: diagram renders at natural size (scale 1.00), smallest text 12px (gate captions, template label), step names and loop count 16px. Cost: the diagram scrolls inside its card (see New issue A). **At 900-1440 the SVG still shrinks**: step names 9.8px (900), 11.3px (1024), 10.9px (1440); gate captions 7.8, 9.1, 8.7px; 14.8 / 11.8px at 1920. This is the PO-approved scale-to-fit behaviour (spec.md "no text shrinking by breakpoints" was verified only on paper), but it is below 12px on desktop (New issue B). |
| 2 | Card footer clipped, not keyboard-scrollable | **Pass.** Footer wraps: 0 clipped footers and 0 `nowrap`/`overflow` footers at every width, none extends past the viewport. The long-profile footer wraps over two lines at 320 and 390 (see `after-320-light.png`). |
| 3 | Quota 5h/7d off screen below 750px | **Pass at 320 to 749**: stacked rows, 0 quota cells outside the viewport, region does not scroll; at 320 each row shows tool, profile, bar, 5h, 7d and reset (see `after-320-light.png`). At 750 the quota region still scrolls horizontally (min-width 710 + padding; reachable, `tabindex=0`) by about 10-25px up to about 760 (New issue C, minor). |
| 4 | Title wrap | **Pass.** Titles take up to 2 lines below 900 (heights 42px), long ui-ux title ends in an ellipsis after 2 lines at 640 and 320. |
| 5 | Totals wrap at 320 | **Partly**: "1 blocked" still sits alone on a second line at 320 (totals height 43px), whole at 360 and wider. Cosmetic, the stats stay intact. |
| 6 | Hold marker on Verify | Observed in the fixture (card 6, Verify and Review both failed). Judged in the review report, not a verify defect. |
| 7 | Skills & rules tint taller than content | **Pass.** The toggle row is one line high in all captures. |
| - | Page horizontal scroll | **Pass.** `scrollWidth` <= viewport at all 15 widths, both themes; no element outside `.card-body` / `.quota-scroll` extends past the viewport. |
| - | Keyboard reachability of scroll regions | **Pass.** Every element that scrolls horizontally has `tabindex=0` (card bodies below 700px, quota at 750). 0 unreachable scrollers at every width. Focus on skip link, quota region, card body and summary gives a solid 3px outline (programmatic focus, `:focus-visible` true). A card body scrolled to the end at 390 (scrollLeft 270 of a 600px diagram). Real Tab key presses were not exercised. |
| - | Contrast | Computed text contrast at 320, 390, 640 and 1440: 233 text nodes, minimum 6.34:1 light, 7.10:1 dark, none below 4.5:1. Non-text 3:1 not measured. |
| - | Touch targets | Summary height 44px at 390 and 640. |

## Fidelity against mockup v5 (640px, both themes)

Matches: header and totals, stacked quota rows with bars, tinted card header and left accent per state, template label, node symbols and borders,
right-angle return path with the count plate, Architect and Ask PO branch, one-line worker footer, Skills & rules toggle, legend, dark tokens.
Differences:
1. Mockup has the "Active tasks / Pinned workflows" heading and "Connected · sample" plus offline-fixture note; the page has a screen-reader-only "Tasks" heading (intended).
2. Mockup quota keeps one horizontal row at 640 and includes two "slot preview" rows and the 5h bar scale; the page stacks the row below 750px (a deliberate fix for finding 3) and has no placeholders.
3. Mockup shows the "↶ 1 · prior" history arrow; no prior-cycle card in the fixture, not compared.
4. Page cards at 640 draw a centred 600px diagram; mockup draws it filling the card. Same scale (about 1.0).
5. The title of card 8 (long ui-ux) shows an ellipsis after 2 lines in the page; the mockup shows 1 line with an ellipsis.

## New observed issues

A. **Phone widths: the current step is often off screen.** At 320 the current-step node is inside the visible part of the card for 3 of 9 cards, at 390 for 6 of 9, at 480 for 8 of 9, 9 of 9 from 640
   (probe, `aria-current` node vs `.card-body`). The user must scroll each diagram sideways to see where the task stands, which is the thing the page is for.
   Scrolling the `[aria-current]` node into view on render (keeping the user's scroll afterwards) would fix it. Should fix; the 560px app window of `/omi-watch` is not affected.
B. **Desktop diagram text below 12px** at 900-1440 (values above). Inherent to the approved scale-to-fit design and also the mockup; readable in the captures but gate captions at 7.8-9.1px are small.
C. Quota region scrolls 10-25px at 750 to about 760px; breakpoint 749 should be about 760.
D. Every card body is `tabindex=0` with the label "scroll horizontally on narrow screens" at all widths, so at 700px and above there are 9 extra tab stops that scroll nothing.

## Not verified

- Real Tab key presses and screen readers (CDP unreachable): order derived from DOM and programmatic focus.
- OS-level dark mode, 200% zoom, `prefers-reduced-motion` (CSS rule exists, page has no motion), non-text 3:1 contrast.
- `npm run check` (not re-run, by instruction).
- Mockup 640 captures were reused from round 1 (identical bytes), not re-captured.

## Result per area

- Round-1 findings 1, 2, 3, 4, 7: fixed at 320, 390, 640 (light and dark). Finding 5 cosmetic remains at 320. Finding 6 is a review matter.
- Before images captured (repo page light, framework page dark) and compared with the after images: the old pages showed one task per tall block with text lines and a small 11px diagram, fixed dark/light only; the new page shows one card per task with the step, state, worker and footer in a single glance.
