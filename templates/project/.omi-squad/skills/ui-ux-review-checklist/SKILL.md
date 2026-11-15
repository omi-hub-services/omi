---
name: ui-ux-review-checklist
description: Use when designing, building or reviewing the UX of a web interface. A prioritised checklist covering accessibility, interaction, performance, layout, typography and colour, motion and forms.
---

# UI/UX review checklist

Condensed and adapted from UI UX Pro Max (`SKILL.md` and `references/quick-reference.md`; MIT,
Next Level Builder). See `../NOTICE.md`. Only the written guidance was kept: the searchable
databases, the search scripts, the font data and the mobile-native rules were left out.

Work through the categories in priority order. Treat the checklist as guidance for judgement, not a
substitute for the project's own design system or rules. Record each unmet item as a finding, with
the screen or component, and what a user would experience.

## 1. Accessibility (critical)

- Text contrast at least 4.5:1 (3:1 for large text); meaningful icons and control boundaries 3:1.
- Visible focus on every interactive element, not hidden under sticky bars or overlays.
- Tab order follows the visual order; everything works from the keyboard; a skip link exists.
- Alt text for meaningful images; decorative images and icons beside text are hidden from assistive
  technology; icon-only controls have an accessible name and state (pressed, expanded, selected).
- Form fields have visible labels; headings go in order without skipping a level.
- Colour is never the only carrier of meaning (add text or an icon).
- Honour reduced motion and text scaling without breaking the layout.
- Anything draggable has a single-pointer and a keyboard alternative; moving content can be paused.
- Pointer targets are at least 24x24 CSS px (WCAG 2.2), and 44x44 for primary touch targets.

## 2. Interaction

- Do not rely on hover alone; primary actions work by click, tap and keyboard.
- Give feedback within about 100 ms of a press; disable and show progress during async work.
- Errors appear next to the problem and say what to do next. Destructive actions need
  confirmation or undo.
- Gesture-only actions always have a visible control as well.

## 3. Performance

- Optimised, correctly sized images, with width and height or an aspect ratio declared.
- Lazy-load below-the-fold and heavy media; load third-party scripts async or defer, and only if
  needed.
- Reserve space for async content (layout shift below 0.1); font loading must not hide text.
- Keep per-frame work small; debounce high-frequency events; virtualise long lists.

## 4. Style consistency

- Match the style to the product, and use the same style on every page.
- Use one icon family and style (no emoji as structural icons); one elevation and shadow scale.
- Hover, pressed, disabled and focus states are visibly distinct, and light and dark themes are
  checked separately, not inferred.
- One primary action per screen.

## 5. Layout and responsive

- Viewport meta set and zoom never disabled; design mobile-first with systematic breakpoints.
- No horizontal scroll; consistent maximum content width; fixed bars reserve space for content.
- Body text at least 16 px on mobile; line length about 60 to 75 characters on desktop.
- A consistent 4/8 px spacing scale and a defined layering (z-index) scale.

## 6. Typography and colour

- Body line height 1.5 to 1.75; one type scale; heading and body faces that suit each other.
- Semantic colour tokens (primary, error, surface) instead of raw values in components.
- Dark mode uses its own tones with its own contrast check, not inverted colours.
- Prefer wrapping to truncation; let long tokens (URLs, IDs) reflow; use tabular figures for
  columns of numbers.

## 7. Motion

- Every animation expresses cause and effect; animate one or two elements per view.
- Animate transform and opacity, not width, height or position; avoid layout shift.
- Use shared duration and easing tokens; exits are shorter than entrances; animations are
  interruptible and never block input.

## 8. Forms and feedback

- A visible label per field, never a placeholder alone; required fields marked.
- Validate on blur, not on every keystroke; the error sits below its own field and is linked to it.
- After a failed submit, focus the first invalid field (or a linked error summary when there are
  several), and keep the inline errors.
- Use semantic input types and autocomplete; allow paste and password managers.
- Helpful empty states; toasts that do not steal focus and are announced politely.

## 9. Navigation

- Predictable back behaviour that preserves scroll and state; key screens reachable by URL.
- The current location is highlighted; navigation placement is the same on every page.
- Modals offer a clear way out and are not used for primary navigation.

## 10. Charts and data

- Match the chart type to the data; include a legend, labels and a text or table alternative.
- Do not rely on colour alone; keep data-to-background contrast at 3:1 or higher.
- Show meaningful empty, loading and error states; respect reduced motion.

## Before you report

Check the real interface at a small phone, a tablet and a desktop width, with keyboard only, with
reduced motion on, and in each theme the product ships. Report what you could not check. Do not
claim a result you did not observe.
