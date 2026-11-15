---
name: frontend-design-quality
description: Use when building, restyling or reviewing a web page or UI component. Keep one design system, real content, consistent layout, and check the result in a real browser at several widths.
---

# Frontend design quality

Condensed and adapted from the Taste skill (`design-taste-frontend`, MIT, Leonxlnx). See
`../NOTICE.md`. Only general design principles were kept. The original's build commands, page
generators, check scripts, stock-photograph and brand-icon handling, and copy-lint rules were left
out; this skill ships no scripts or assets.

## Principle

Build the page a good team would ship: it says plainly what it offers, shows the real thing, and
looks made for this project, not assembled from a template. Use the project's existing design
system, components and tokens first. Add no new framework, font service or asset source without a
recorded decision.

## House rules

1. **One system.** One button pair, one card style, one radius scale, one link look, one heading
   scale. Use tokens, not one-off values. No nesting boxes inside boxes without a reason.
2. **Real content.** Show the actual product, screens or data the task provides. Do not invent
   customers, quotes, reviews, figures, logos or contact details. Mark placeholders as placeholders
   and list them in your report. Do not present stock imagery as the client's own.
3. **Plain copy.** Headings name the thing. A button says a verb and an object. One main action per
   screen, with secondary actions visibly subordinate.
4. **Clear structure.** One idea per section, equal left and right content edges, consistent
   spacing rhythm, nothing sparse or half-empty, nothing colliding or overlapping.
5. **Every visual renders.** No empty image or media area, no caption that only labels or apologises
   for a picture. Reserve space for images and async content to avoid layout shift.
6. **Quiet motion.** Interactive elements answer the pointer and keyboard (hover, press, focus).
   Motion has a cause and an effect; animate one or two things per view; nothing blocks input.
   Respect reduced-motion, give anything moving for more than five seconds a pause control, and do
   not hide content behind scroll-triggered fades.
7. **Accessibility is not optional.** Contrast, visible focus, labels, alt text, heading order,
   keyboard order and target size. See `ui-ux-review-checklist` for the checks.

## Verify in a real page

Do not judge from the code alone. Run the page with the project's own dev or build command, and
look at it at 1440, 1024, 768 and 390 px wide (320 px for overflow). Check:

- the first screen says what is offered and has its main action visible;
- no horizontal scroll, no overlap, nothing hidden behind a fixed bar;
- every control is reachable and named by keyboard, with focus visible;
- text contrast, loading and error and empty states, and form errors under their own field.

Use only tools the project already has; do not install a browser or a checker for this. If you
cannot run the page, say so in your report and list what you could not check. Do not claim a visual
result you did not see.

## Never

- Scroll-jacking, parallax on text, random blinking, a fade-in on every section.
- Copying another site's code, copy, pictures or signature effect.
- Editing a check, a rule or a threshold so a failing page passes.
- Drawing a look-alike of a real brand's logo.
