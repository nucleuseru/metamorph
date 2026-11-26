---
version: alpha
name: Expo Dark System
description: A dark-only, minimal, developer-focused product system following expo.dev with crisp typography, subtle slate layering, and restrained blue accents.
colors:
  primary: "#0090ff"
  primary-hover: "#3b9eff"
  on-primary: "#ffffff"
  secondary: "#edeef0"
  tertiary: "#2e3135"
  neutral: "#111113"
  card: "#18191b"
  surface: "#212225"
  on-surface: "#edeef0"
  error: "#e5484d"
  error-hover: "#ec5d5e"
  error-text: "#ff9592"
  border: "#363a3f"
  muted: "#b0b4ba"
  accent-soft: "#0d2847"
  accent-text: "#70b8ff"
typography:
  headline-display:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: 600
    lineHeight: 52.8px
    letterSpacing: -1.2px
  headline-lg:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: 600
    lineHeight: 43px
    letterSpacing: -0.5px
  headline-md:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: 600
    lineHeight: 43px
    letterSpacing: -2px
  headline-sm:
    fontFamily: Inter
    fontSize: 21px
    fontWeight: 600
    lineHeight: 25px
    letterSpacing: 0px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 500
    lineHeight: 28px
    letterSpacing: 0px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 500
    lineHeight: 22.4px
    letterSpacing: 0px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0px
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0px
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0px
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0px
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 32px
  full: 9999px
spacing:
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 24px
  section: 64px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 0px 12px
    height: 44px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 0px 12px
    height: 44px
  button-tertiary:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.none}"
    padding: 0px
    height: 0px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: 16px
  input:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 12px
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px 10px
  badge:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px 8px
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.none}"
    padding: 0px
---

# Expo Dark System

## Overview

Expo Dark System is a dark-only design language following `expo.dev` (`@expo/styleguide-base` built on Radix UI Colors v3 `slateDark`, `blueDark`, and `redDark`). There is no light mode and no theme switcher: the entire product renders on a deep near-black slate canvas (`#111113`), using controlled tonal steps (`#18191b`, `#212225`, `#2e3135`), crisp 1px hairline borders (`#363a3f`), high-contrast off-white typography (`#edeef0`), and restrained Expo software blue (`#0090ff`) reserved for primary actions and active focus states.

## Colors

- **Primary (#0090ff):** `blueDark.blue9` — Expo vivid software blue used for primary action fills, active control states, and focus rings.
- **Primary-hover (#3b9eff):** `blueDark.blue10` — Lighter blue hover and active feedback state on dark surfaces.
- **On-primary (#ffffff):** Crisp white foreground text and icons inside solid `primary` buttons.
- **Secondary (#edeef0):** `slateDark.slate12` — High-contrast off-white used for secondary meters, inverted high-contrast indicators, and primary ink parity.
- **Tertiary (#2e3135):** `slateDark.slate5` — Raised slate tone for slider and meter tracks, switch wells, and secondary hover fills.
- **Neutral (#111113):** `slateDark.slate1` — The base dark-only application canvas, stage viewport floor, and input field recess.
- **Card (#18191b):** `slateDark.slate2` — Primary elevated container fill for cards, dialogs, popovers, and sidebars.
- **Surface (#212225):** `slateDark.slate3` — Subtle nested surface fill for chips, secondary buttons, tabs, alert panels, and inset containers.
- **On-surface (#edeef0):** `slateDark.slate12` — Default high-contrast readable foreground color for headings and body content on dark backgrounds.
- **Muted (#b0b4ba):** `slateDark.slate11` — Accessible cool slate gray for navigation links, helper text, and secondary descriptions.
- **Error (#e5484d):** `redDark.red9` — Solid destructive button fill reserved sparingly for irreversible or failed states.
- **Error-hover (#ec5d5e):** `redDark.red10` — Lighter red hover state for destructive actions.
- **Error-text (#ff9592):** `redDark.red11` — High-contrast soft coral-red for inline error text, destructive alerts, and error badges on dark surfaces.
- **Border (#363a3f):** `slateDark.slate6` — Standard 1px hairline border and divider color for cards, inputs, and controls.
- **Accent-soft (#0d2847):** `blueDark.blue3` — Deep dark blue tint for badges, active selection fills, and informational highlights.
- **Accent-text (#70b8ff):** `blueDark.blue11` — Accessible sky-blue foreground text and icon accent for links, badges, and selected chips on dark surfaces.

## Typography

Inter is the primary family across the site, giving the interface a modern, neutral, highly legible voice. Headlines are semibold and tightly tracked, with the largest display style at 48px for hero messaging and the next levels stepping down cleanly for section hierarchy. Body text is slightly emphasized at 500 weight, which helps the content feel crisp and product-forward rather than editorially light.

The system uses JetBrains Mono for code-like or technical metadata moments, such as timers, stats, labels, or implementation details. Letter spacing is negative on large headlines to create compact, confident wordmarks and hero statements, while smaller labels and nav items remain neutral with no visible uppercase treatment. Use `headline-display`, `headline-lg`, `headline-md`, and `headline-sm` for page hierarchy; use `body-md` and `body-sm` for descriptive copy; use `label-md` and `label-sm` for buttons, chips, and navigation.

## Layout

The layout is spacious and centered, with strong vertical rhythm and generous gaps between hero, trust signals, and supporting sections. Content sits in a fixed-max-width container with generous outer canvas breathing room, rather than a dense full-bleed grid. The spacing scale favors 8px-based increments, with 16px, 24px, 40px, and 64px steps used to separate content blocks, align cards, and create breathing room around primary workspaces.

Section padding should be generous, especially around feature blocks and promotional cards, while component padding stays compact to preserve the clean, high-density product feel inside controls. Cards and panels should usually use 16px inner padding with broader section gaps around them. Buttons and pills should remain compact horizontally, with minimal text padding and consistent 44px control height.

## Elevation & Depth

The system is flat, tonal, and border-led, relying on controlled slate surface steps and crisp 1px outlines (`#363a3f`) instead of heavy drop shadows. Depth comes from structured slate layering:

`#111113` canvas (`neutral`) → `#18191b` containers (`card`) → `#212225` nested surfaces & controls (`surface`) → `#2e3135` tracks & active hover states (`tertiary`).

Keep inputs recessed at `#111113` inside `#18191b` cards so form boundaries read clearly without heavy chrome. The overall hierarchy should feel structural, technical, and effortless to scan in low-light environments.

## Shapes

Expo uses a soft, modern shape language built around rounded pills for actions and medium rounding for containers. Primary controls are strongly rounded with `rounded.full`, giving buttons a friendly, productized feel. Cards and panels use `rounded.md`, which is enough to soften the system without drifting into playfulness.

Avoid sharp decorative geometry for core UI elements. The shape system should feel minimal, stable, and smooth, with circles or pill forms reserved for badges, buttons, and compact UI affordances.

## Components

Buttons should be the clearest expression of hierarchy. `button-primary` is the main call to action: `primary` (`#0090ff`) fill, white (`#ffffff`) text, semibold label style, 44px height, and fully rounded ends, shifting to `primary-hover` (`#3b9eff`) on hover. `button-secondary` is a softer companion action with `surface` (`#212225`) fill, `on-surface` (`#edeef0`) text, 1px `border`, and the same compact pill sizing, shifting to `tertiary` (`#2e3135`) on hover. `button-tertiary` stays visually quiet and text-only for links or lightweight actions, using `accent-text` (`#70b8ff`) on hover.

Cards should use the `card` token: `#18191b` background, 1px `border` (`#363a3f`), `rounded.md`, and 16px padding. Inputs should sit recessed at `#111113` with 1px `border`, `rounded.md`, comfortable internal padding, and a restrained focus ring that relies on `primary` (`#0090ff`).

Chips and badges should be small, pill-shaped, and legible against dark surfaces. Use `chip` (`#212225` fill, `#edeef0` text) for neutral tags and `badge` (`#0d2847` `accent-soft` fill, `#70b8ff` `accent-text`) for highlighted labels such as status markers. Destructive text inside alerts, inline errors, and subtle badges should use `error-text` (`#ff9592`), reserving solid `error` (`#e5484d`) for destructive button fills. Navigation links remain text-first and understated using `nav-link`, with `muted` (`#b0b4ba`) foreground color and no border chrome.

## Do's and Don'ts

- Do enforce dark-only rendering (`color-scheme: dark`) with no light theme or theme toggle.
- Do use Inter for all core interface text and reserve JetBrains Mono for technical or code-like content.
- Do step slate surfaces cleanly (`#111113` → `#18191b` → `#212225` → `#2e3135`) and pair them with 1px `#363a3f` borders.
- Do use `accent-text` (`#70b8ff`) and `error-text` (`#ff9592`) for colored text and icons on dark surfaces to preserve high readability.
- Do keep primary actions pill-shaped, compact, and visually clear with the `primary` (`#0090ff`) color.
- Don't reintroduce light-mode backgrounds (`#ffffff`, `#f8fafc`), dark ink (`#1c2024`), or low-contrast dark-on-dark accents.
- Don't introduce saturated secondary accent colors that compete with `primary`.
- Don't use large corner radii on cards or feature containers; keep `rounded.md` for surfaces.
- Don't overuse drop shadows, neon glows, or decorative gradients; the brand should stay clean, tonal, and technical.
