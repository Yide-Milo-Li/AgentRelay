---
name: AgentRelay
description: A shared cross-device prompt handoff box for trusted accounts, drawn as a transit strip map.
colors:
  ink: "#14171a"
  ink-2: "#454b53"
  muted: "#646b75"
  surface: "#ffffff"
  sunken: "#f7f8fa"
  select: "#eceff3"
  hair: "#e4e6ea"
  hair-strong: "#d2d6dc"
  track: "#dde1e6"
  stop: "#7e858f"
  line-blue: "#1462d6"
  line-amber: "#b87d00"
  line-green: "#108a55"
  line-violet: "#7348d1"
  line-teal: "#0a8798"
  line-brown: "#96602b"
  line-neutral: "#7a818b"
  danger: "#c4312a"
  warn: "#9a6200"
  ok: "#1a8450"
  storage-text: "#2a78d6"
  storage-database: "#1baf7a"
  storage-images: "#eb6834"
typography:
  display:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "-0.022em"
  headline:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 620
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  station:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-strong:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "-0.005em"
  label:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.4
  meta:
    fontFamily: "Geist Variable, Geist, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"tnum\" 1"
  mono:
    fontFamily: "Geist Mono Variable, Geist Mono, Cascadia Code, Consolas, PingFang SC, Microsoft YaHei, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  xs: "5px"
  sm: "6px"
  md: "8px"
  field: "9px"
  lg: "10px"
  xl: "12px"
  dialog: "16px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "28px"
  2xl: "36px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #14171a 86%, #ffffff)"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.sunken}"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "30px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "36px"
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    size: "34px"
  icon-button-hover:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0 12px"
    height: "40px"
  search-field:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "0 6px 0 12px"
    height: "38px"
  segmented:
    backgroundColor: "{colors.select}"
    textColor: "{colors.muted}"
    rounded: "{rounded.field}"
    padding: "3px"
  segmented-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "28px"
  tab:
    textColor: "{colors.muted}"
    padding: "0 12px"
  tab-active:
    textColor: "{colors.ink}"
  tab-count:
    backgroundColor: "{colors.select}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.lg}"
    height: "20px"
  device-pick:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 10px 0 12px"
    height: "34px"
  lang-switch:
    backgroundColor: "{colors.select}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "3px"
    height: "34px"
  handoff-row:
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 12px"
  handoff-row-hover:
    backgroundColor: "{colors.sunken}"
  handoff-row-selected:
    backgroundColor: "{colors.select}"
  prompt-block:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "16px 0"
  tag:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  menu:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "4px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "10px 8px 10px 14px"
  compose-dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "28px"
    width: "min(620px, calc(100vw - 32px))"
---

# Design System: AgentRelay

## Overview

**Creative North Star: "The Transit Strip Map"**

A handoff is a short ride on a line from one device to another, and its status is how far the train has got. AgentRelay borrows the strip maps printed above train doors: a single horizontal line, round station dots, the name of each stop, and one colour that tells you which line you are on. Everything else in the interface stays out of the way. The ground is enamel white by day and deep blue-black at night, the type is near-black ink set in Geist, and the only ornament is strokes and dots. Prompt text sits in Geist Mono with line numbers, exactly as it was sent.

The density is low because the user arrives between tasks and wants to leave quickly. One list column, one reading pane, hairline dividers between them. Colour carries meaning only: each destination device owns a metro line colour, so a route can be recognised in a row before it is read. Chrome, focus, selection, tabs and the primary action are all ink. The status-pill inbox with a grey sidebar, which is the usual way to draw this category, is deliberately absent; status is expressed as position on a line.

Motion has one job. When a handoff is claimed or completed, the line fill extends and the train dot glides to the next stop, with the stations lighting up in sequence. Everything else (rows, the detail pane, menus, the toast) enters with short exponential ease-out fades and then holds still. Appearance initially follows `prefers-color-scheme`; Settings › General offers System, Light and Dark as a segmented control and remembers the choice in this browser. All motion collapses under `prefers-reduced-motion`.

**Key Characteristics:**
- Strip-map route as the status display: source station, claimed stop, target station.
- One line colour per destination device; ink for every other piece of chrome.
- Hairline dividers and tonal tiles instead of cards; no card nested in a card.
- Geist for interface text, Geist Mono for text the user copies verbatim.
- Light and dark from the system by default, with a remembered manual override; English by default with a Simplified Chinese toggle.
- A single orchestrated motion on status change; quiet fades elsewhere.

## Colors

Near-black ink on enamel white, with a six-line metro set plus a neutral line that only ever names where a handoff is going.

All values below are the light scheme from `:root`. Under `:root[data-theme="dark"]` the same token names are redefined; night values are given in parentheses and live in the sidecar. The theme provider resolves System mode before paint and updates it when the OS preference changes; manual Light and Dark modes override the OS.

### Primary
- **Signal Ink** (night `#edf0f3`): body text, headings, the primary button fill, the active tab underline, the focus outline (2px, 2px offset), text selection (16% ink), the brand mark and the Agents setup line. Ink is the system's only interaction colour.

### Secondary
The metro line set. A line colour belongs to a registered device (`devices.line`): it is chosen from these seven lines, survives a rename, and is resolved by device id through `resolveStop` in `src/shared/formatting/device-identity.ts`. A name that is not registered falls back to `heuristicLine(name)`. Either way it is applied through `data-line`, which sets `--line` for the subtree.
- **Desktop Blue Line** (night `#4d8cff`): the default for a device named "Desktop" / "台式机".
- **Laptop Amber Line** (night `#f0b03a`): the default for "Laptop" / "笔记本".
- **Phone Green Line** (night `#33bd7e`): the default for "Phone" / "手机".
- **Spare Violet, Teal and Brown Lines** (night `#a283f2`, `#2fb5c6`, `#cf9158`): other names, by a stable hash of the normalised name. A new registered device takes its heuristic colour if no other device uses it, otherwise the first colour nobody uses.
- **Any-Device Grey Line** (night `#8f97a1`): the reserved "Any device" / "任意设备" target, and a colour a person may pick. The registry never assigns it automatically.

### Tertiary
- **Emergency-Stop Red** (night `#f0615a`): destructive actions only: the delete menu item, the delete confirmation strip (6% tint, 30% border) and the confirm button. Also form error text.
- **Caution Amber** (night `#e8a83a`): connection and missing-link warnings only, as a 12% tint with a 34% border and the icon in full colour. It is a state token, separate from the Laptop line even though the hue is close. It also colours the dot and word of an *Unused* or *Idle* agent connection and the "Expires in…" line of one that ends within 14 days, as text with no tint, because the same state is written out in words beside it.
- **All Clear Green** (night `#3fbf7f`): the 6px "Synced" dot in the list footer, and the 7px dot with the word *Active* on an agent connection whose secret was accepted in the last 30 days. Nothing else.
- **Storage data colours** (`--storage-text` `#2a78d6`, `--storage-database` `#1baf7a`, `--storage-images` `#eb6834`; night `#3987e5`, `#199e70`, `#d95926`): the Storage composition bar and its legend only. They name a kind of stored data, never a device, so they are separate tokens from the metro lines. Uploads awaiting cleanup reuse the image colour as a 135° hatch. The three hues pass the dataviz palette validator in both themes (lightness band, chroma floor, CVD and normal-vision separation for all pairs); the aqua sits at 2.8:1 on white, so the legend always carries name, size and share beside the swatch.

### Neutral
- **Enamel White** (night `#12161b`, "Night Platform"): page ground and every surface: top bar (92% with blur), panes, menus, dialog.
- **Tile Wash** (night `#181d23`): the raw prompt block, code panels, search field, row hover, the one-time token reveal.
- **Selected Tile** (night `#1b2128`): selected row, segmented and language-switch tracks, the inbox count.
- **Platform Graphite** (night `#bcc2ca`): secondary text such as field labels, tags and code panel text.
- **Timetable Grey** (night `#8d959f`): metadata, times, line numbers, captions, unreached station names, placeholders.
- **Hairline** (night `#20262d`): pane and section dividers, list foot, token rows.
- **Rule Line** (night `#2d343d`): borders on secondary buttons, inputs, the device picker and tags; scrollbar thumb.
- **Unridden Track** (night `#2a3139`): the unfilled part of a route line and the empty-state line.
- **Unreached Stop** (night `#6b7480`): the ring of a station the train has not reached.

### Named Rules
**The Line Names the Destination Rule.** Line colour enters the interface only through `data-line`, keyed to a device (by registry id, or by the heuristic for an unregistered name). The swatch picker and the connection-group heading are the only places a colour is chosen or shown without a route, and both still name a device. In the connection list the heading's dot takes the line colour only when the list is grouped by device; member and agent headings name no device, so their dot is the neutral line. The one exception is the project swatch: each project borrows a line colour (assigned automatically, least used first) and shows it only as an 8px square with 2px corners beside the project name. Square, never round, so it can't be read as a station or a destination. It never decorates chrome, never marks focus or selection, and never stands for success or warning; those states have their own tokens (Caution Amber, All Clear Green, Emergency-Stop Red). If a colour is not telling you which line a handoff rides (or which line this device sits on, in the device picker), it should be ink or a neutral.

**The Three-to-One Stop Rule.** An unreached station uses the Unreached Stop ring, which holds at least 3:1 against Enamel White in both themes (about 3.7:1 light, 3.8:1 dark, and at least 3.2:1 on a selected row). The Unridden Track is allowed to be faint because the stops, not the track, carry the state.

**The Ink Chrome Rule.** Tabs, the primary button, focus outlines, selection and the brand mark are ink. In dark mode the primary button inverts to a light ink fill with a dark label; it does not pick up a line colour.

**The Word Beside the Dot Rule.** The health of an agent connection is a 7px dot followed by its word (Pending setup, Unused, Active, Idle) in 12px medium type. Colour never carries it alone: the word is always there, and the dot is Timetable Grey unless the connection is Active (All Clear Green) or needs a look (Caution Amber). It describes use of a credential, never whether an agent is online, and it has no fill and no border, so it is not the coloured status pill that handoffs avoid.

## Typography

**Display Font:** Geist Variable (self-hosted via `@fontsource-variable/geist`, with PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Noto Sans SC, system-ui)
**Body Font:** Geist Variable (same stack)
**Label/Mono Font:** Geist Mono Variable (self-hosted via `@fontsource-variable/geist-mono`, with Cascadia Code, Consolas, then CJK fallbacks)

**Character:** A neo-grotesk set like station signage: tight negative tracking on headings, medium weights (550 to 650) rather than bold, and CJK falling back to the platform's own sans. Mono appears only where the text is a payload.

### Hierarchy
- **Display** (620, 30px, 1.2, -0.022em): the Agents page title. 25px under 720px.
- **Headline** (620, 28px, 1.25, -0.02em): the handoff title in the detail pane, balanced wrapping. 23px under 720px.
- **Title** (600, 22px): compose dialog heading and empty-state heading.
- **Station** (600, 20px, 1.25, -0.02em): station names on the full route strip; ink once passed, Timetable Grey before. 16px under 720px.
- **Body** (400, 15px, 1.55): default text. Explanatory paragraphs cap at 38 to 64ch.
- **Body Strong** (550, 15px, 1.4): row titles, clamped to two lines.
- **Label** (550, 14px): buttons, tabs (14.5px, 500), field labels (13px, 550).
- **Meta** (400, 12.5px, tabular numerals): times, mini-route device names, list foot, character counts.
- **Mono** (400, 13.5px, 1.75): the raw prompt and the prompt textarea; 12.5px for code panels and the token secret. Line numbers are 12px Timetable Grey, not selectable.
- **Brand** (650, 17px, -0.015em): the "AgentRelay" wordmark beside the two-station mark.

### Named Rules
**The Mono Is Payload Rule.** Geist Mono marks text that is copied or sent verbatim: the prompt, the prompt input, the agent rule, the MCP config, MCP tool names, device ids and a new token. Interface text never uses mono.

**The Tabular Time Rule.** Every time, count and character total uses tabular numerals so rows and route captions do not jitter as values change.

## Layout

The app is exactly one viewport tall: a 60px top bar over a two-pane workspace that fills the rest. The stage scrolls when a view is taller than the window; inside the inbox the list and the detail pane each scroll on their own, so a long prompt never moves the list. The list pane is `minmax(300px, 380px)` with a hairline on its right; the detail pane takes the rest and centres its content at a 900px maximum. The detail header (title and actions) is pinned to the top of the pane, covering the detail padding, and gains a hairline only once text slides under it. Prompt text always wraps; there is no wrap toggle. Side gutters are 28px in the top bar and 48px in the detail column at full width. The Devices, Agents and Settings views replace the workspace with a single centred column of 808px (Settings › Storage uses the 1180px storage width).

Spacing follows a 4px base with a working set of 4, 8, 12, 16, 20, 28, 36 and 48px. The list uses 16px tool padding and 8px list padding; rows are 14px by 12px with 10px between title line and route. The full route strip sits 36px below the actions and 30px above the prompt.

Responsive steps:
- **≤1180px:** the "This device" caption hides; detail padding drops to 32/36px.
- **≤920px:** gutters drop to 20px, the list narrows to `minmax(270px, 320px)`, and New handoff collapses to a 36px icon button.
- **≤720px:** the top bar becomes a two-row grid (brand, device, settings, new / tabs). The page scrolls as a whole again, and the pinned detail header sticks just below the top bar, whose measured height is exposed as `--topbar-h`. The tab strip scrolls sideways inside its own area instead of wrapping or widening the page. A device row puts its name and menu on the first line and its id and actions under the name. The workspace becomes a single column: the list is the page, selecting a row drills into the detail with an "All handoffs" back link. Detail padding is 18px, the route strip and stations shrink, and action buttons drop their icons except on the primary.
- **≤420px:** the wordmark hides and the device picker tightens further.

## Elevation & Depth

The system is flat. Depth comes from tonal tiles (Tile Wash, Selected Tile) and hairlines, not shadows. Only things that float above the page cast one: the overflow menu, the toast and the compose dialog. A thin 1px lift distinguishes the active thumb in the segmented control and the language switch. The top bar uses a translucent surface with `saturate(1.4) blur(10px)` so the list scrolls under it.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 14px 36px -10px rgb(16 22 30 / 0.22), 0 2px 6px -2px rgb(16 22 30 / 0.08)`; dark `0 18px 44px -12px rgb(0 0 0 / 0.6), 0 2px 6px -2px rgb(0 0 0 / 0.4)`): menu, toast, compose dialog.
- **Thumb** (`--shadow-thumb`: `0 1px 2px rgb(16 22 30 / 0.12)`; dark `0 1px 2px rgb(0 0 0 / 0.5)`): active segment and the sliding language thumb.
- **Train halo** (`box-shadow: 0 0 0 4px <surface>, 0 0 0 5px <line at 30%>`): the full-strip train, so it reads as sitting on top of the track.

### Named Rules
**The Flat Until Floating Rule.** A surface gets the Pop shadow only if it overlays other content. Panels, rows, the prompt block and banners stay flat.

## Shapes

Corners are gently rounded and scale with the size of the object: 5px tags, 6px inner segments and menu items, 8px buttons and the prompt block, 9px inputs and the search field, 10px rows, banners and menus, 12px panels and the toast, 16px for the compose dialog. The device picker and language switch are full pills. Stations, trains and the device dot are perfect circles; route lines are 2px (mini) or 6px (full) bars with rounded ends. Borders are 1px hairlines; the only thick strokes are station rings (2px mini, 5px full) and the 3px Agents setup line.

## Components

### Buttons
Restrained and dense, with a slight press.
- **Shape:** gently rounded (8px), 36px tall, 14px side padding; small variant 30px.
- **Primary:** ink fill with a surface-coloured label. Used once per context: New handoff, Copy prompt, Send, Add device, Create connection. On copy, its icon swaps to a check and pops (scale 1.25, 0.45s).
- **Secondary:** surface fill with a Rule Line border; hover moves to Tile Wash with a Timetable Grey border. Claim and Mark done are secondary.
- **Danger:** Emergency-Stop Red fill, white label, only on the button that confirms an irreversible change: the delete strip, and the confirm button of a revoke, rotate or remove-access dialog. The one place it appears before a confirmation is *Revoke selected…* in the connection selection bar, which opens a preview dialog and revokes nothing itself.
- **Icon:** 34px square, Timetable Grey glyph, Tile Wash on hover. Used for copy link, download and the overflow menu.
- **Text link:** ink text whose underline fades in on hover (4px offset).
- **Press / Disabled:** `scale(0.98)` on press; disabled is 45% opacity with a not-allowed cursor.

### Chips
- **Segmented status filter:** a Selected Tile track (9px, 3px inset) holding All / Ready / Claimed; the active segment becomes a surface-coloured thumb with ink text and the Thumb shadow.
- **Inbox count:** a 20px Selected Tile capsule with Platform Graphite tabular numerals beside the Inbox tab.
- **Sample tag:** a 1px Rule Line outline, 5px corners, 11.5px text; marks illustrative handoffs.
- **Project tag:** the project's square swatch and its name in 12px medium Platform Graphite, no outline. It sits on its own line under the route in a row (with the image count), and inline in the detail footer. A handoff without a project shows nothing in the row and "No project" in the footer.
- **Agent badge:** the agent a connection was made for (Claude Code, Codex, Antigravity): a full-pill outline, 1px Rule Line border, 11.5px medium Platform Graphite, no fill, beside the connection's name. It is the choice made in the wizard, not proof of what runs on the other end, and it hides when the list is grouped by agent. What the agent reports about itself is a separate muted line ("Reports as codex-cli 0.42.1"), never a badge.
- **Project filter:** a quiet native select after the device filter ("All projects", then projects by last use with the current tab's count, then "No project" when that tab has unfiled handoffs). The two selects wrap together and stay at the right edge, followed by a 26px folder icon button that opens Manage projects; quiet selects size to the selected label where `field-sizing` is supported.
- **Manage projects dialog:** a compose-sized dialog with a hairline list like the device registry: each row has the square swatch, the name, a muted handoff count and an overflow menu (Rename, Merge into…, Archive or Unarchive, Delete project). Rename edits inline (Enter saves, Escape cancels). Merge and delete open the danger-tinted confirm under the row; merge names the target in a select and says what moves. Archived projects follow under a muted "Archived" heading. Escape closes the innermost open layer first.

### Cards / Containers
There are no cards. The list pane, detail pane and Agents column are separated by hairlines.
- **Rows:** 10px corners, transparent at rest, Tile Wash on hover, Selected Tile when current. Each row is a title line (two-line clamp, time at right) above a mini route strip.
- **Prompt block:** Tile Wash, 8px corners, line-numbered mono text, wrapping long lines in place.
- **Panels (Agents view):** 1px Hairline border, 12px corners, a header row with a small button, and a Tile Wash code body. A panel contains code, never another panel.
- **Banners:** 10px corners; the note banner is Tile Wash with a hairline, the warning banner uses Caution Amber.

### Inputs / Fields
- **Style:** 40px tall, 9px corners, 1px Rule Line border on surface, 15px body text; the prompt textarea is mono, 220px minimum, resizable vertically.
- **Focus:** border shifts to ink with a 3px ink ring at 10%.
- **Search:** sits on Tile Wash with a hairline and lifts to surface when focused.
- **Destination field:** shows the target line's dot inside the input, so the colour appears as the device is typed.
- **Project field:** optional and empty by default (no project). A combobox whose menu lists "No project", then the active projects by last use; typing filters by name key (archived projects become findable, tagged "Archived") and offers "Create project “…”" for a new name. The square in the input is hollow when empty, a coloured ring for a name that will be created, and filled for an existing project; a new name also gets a muted note below the field.
- **Error:** Emergency-Stop Red text below the form.

### Navigation
- **Top bar:** brand mark and wordmark, then Inbox / Done / Devices / Agents tabs, with the device picker, a Settings gear and New handoff on the right at every width. Tabs are 14.5px medium Timetable Grey; the active tab turns ink and gains a 2px ink underline that scales in from the centre (0.4s).
- **This-device picker:** a pill showing a dot in this device's line colour (with an 18% halo), a "This device" caption, the device name and a chevron that turns over while open. It opens a standard menu (not a native select) listing the registered devices, each with its line-colour stop and a check on the current one, then this browser's own name tagged "not registered" when it matches none, then a hairline and "Manage devices…", which opens the Devices tab and leaves the selection alone. Arrow keys, Home/End and Escape work as in any menu. A browser that has not chosen its device shows a dashed pill with a hollow dot and "Choose…"; nothing guesses the device.
- **Which device is this?:** a dialog with the registered devices as tiles (the current one darkened), chips for the common machines not registered yet, and "Other…" that opens the name and id form. Adding a device here also makes it this browser's device.
- **Setup checklist:** in place of the empty inbox (and in the list pane on phones), a 540px column: title, one muted line, then four rows on hairlines, each with a 24px ring numeral that fills with ink and a check when done. Only the first open row shows its sentence and one action; done rows say what is true, and a statement the page cannot check (plugin use) is labelled as the person's own. Once handoffs exist it folds into a one-line progress entry above the list; it ends for good, remembered per browser, when a handoff is claimed on a device other than its sender. Hidden before that, it comes back from Settings › General › Workspace.
- **Earlier guess:** a browser that an earlier version set to Laptop without asking shows a note banner above the list, "Is this browser Laptop?", with *Yes, it is* and *Choose another*, until it is answered.
- **Settings:** a gear in the top bar opens a centred view with General (language, appearance), Keyboard (the single-key switch and the full shortcut list), Workspace (account, sharing and this device), a Notifications section for this browser and a Storage section that holds the storage manager. Each setting is a row with its label and a one-line note on the left and its control on the right; groups are separated by hairlines. The storage usage chip sits in the list footer beside the sync state, muted until the database nears its limit, and opens Settings › Storage.
- **Language switch:** EN / 中文 on a Selected Tile pill with a sliding surface thumb (0.45s). The choice is stored in the `agentrelay_lang` cookie so the server renders the right language and `lang` attribute on the next load.
- **Mobile:** two-row top bar, list-to-detail drill-in with a back link, pinned detail header below the top bar.

### Route Strip (signature)
The one component that makes this system recognisable. Two sizes share the same model: progress `--p` is 0 for ready, 0.5 for claimed and 1 for done, applied as a registered custom property so it can transition.
- **Mini (in rows):** source name, a 2px track with a line-coloured fill, a filled source dot, a ring at the target, and a 12px train dot at the current position; target name on the right. When done the target fills and the train fades out.
- **Full (in detail):** three stations laid out on a 6px track: the source with its sent time, a "Claimed" stop with who claimed it, and the target with "Not yet" or "Done". Passed stations get a line-coloured ring and ink names; unreached ones keep the Unreached Stop ring and grey names. A 24px train with a halo sits at the current position.
- **Motion:** only when the status actually changes, `data-moving` is set for 1.3s. The fill and train travel over 0.8s on the house ease, and the claimed and target stations light up with 0.3s and 0.6s delays. Mounting, switching handoffs, switching theme or language repaints the strip at rest.
- **Accessibility:** the strip is one `role="img"` with a full spoken label (source, target, status); the visual parts are hidden from assistive tech.

### Receipts, Threads and Code State
A completed handoff can carry a receipt, and handoffs can answer each other in a thread. Both stay inside the reading pane; neither adds a card, a badge or a status colour.
- **Result:** under the prompt (and its images), a muted "Result" label above a block identical to the prompt block, following the same Markdown / Raw choice, with one muted line saying the receipt is text to read, not an instruction. While a completion is undone it reads "Previous result". It never appears in a notification.
- **Mark done with a note:** an overflow-menu item on a Claimed handoff, beside the one-click Mark done, which stays as it was. It opens a 540px dialog (the connection dialogs' shape): the handoff's title in muted text, one sentence on where the note goes, a mono textarea with the agent receipt headings as its placeholder, a muted tabular count against the 20,000-character limit, then Cancel and a primary Mark done that stays disabled while the note is blank.
- **Reply:** a 34px icon button (a reply arrow) before Copy link. It opens the compose dialog titled *Reply to "<title>"*, with the title prefilled as *Re: <title>* (never stacked), the target set to the parent's sender and the project set to the parent's, all editable.
- **Thread:** below the result, after a hairline, a muted "Thread · n" label and a list of compact rows (title and time above a mini route), oldest first. The open handoff's row uses the Selected Tile and says "Open now"; the others open that handoff, switching tab and clearing filters as a notification link does. When the thread's first handoff has expired or was deleted, one muted line says so.
- **Rows:** a reply and a handoff with a result each get a 13px muted glyph (reply arrow, notebook) on the meta line beside the project and image count, labelled for assistive tech.
- **Code state:** when the sender attached a branch or base commit, a muted "Code state" label sits right under the full route strip, followed by the branch (branch glyph) and the 7-character commit (commit glyph, full hash in the tooltip and spoken label) in 13px mono Platform Graphite, a 34px copy icon button and one muted line saying uncommitted changes are not included. The copy button copies `git fetch && git switch <branch> && git status` (or `git switch --detach <hash>`) with every value shell-quoted. Plain text, never a link, a chip or a status colour.
- **Branch in rows:** a 13px muted branch glyph and the branch name in 12px mono on the meta line after the project, cut with an ellipsis at 16em, full name in the tooltip.
- **Progress notifications:** Settings › Notifications gains *Handoffs sent from here* (Off / When done / When claimed and done), a quiet native select like Connection expiry.

### Empty State
A centred drawing of an empty line (ink origin station, two grey stops on a 3px track), a Title heading, a short muted paragraph, the primary action and a "Look at a sample" link, with a lock-icon privacy note below.

### Agents Setup Line
The three setup steps are stations on a vertical 3px ink line with 15px rings, the first filled. The order on the line is the instruction.

### Devices View
A hairline list in the 808px column, one row per registered device, no cards. Each row has a line-coloured dot button (it opens the swatch picker), the name (click Rename for an inline input with an ink border; Enter saves, Escape cancels), an outline "This device" chip, a mono id chip with a copy button, a small "Use on this browser" button for any other device, and an overflow menu (Rename, Change colour, Delete).
- **Swatch picker:** seven 30px circles, one per line; the chosen one has a 2px ink ring. It is a group of toggle buttons, not a colour wheel.
- **Delete:** the existing confirm strip, in Emergency-Stop Red, saying how many open handoffs and active connections use the device. When connections are bound it offers a checkbox to revoke them; otherwise they stay valid and lose their device, so `self` stops working for them. Each Devices row shows its usable connections as a link that opens the Agents list narrowed to that device.
- **Add a device:** a panel with a name field and a mono id field. The id follows the name until it is edited, is flagged under the field when invalid, and cannot change after creation.
- **Seen in handoffs:** names that appear on real handoffs but match no device, each with a one-click Add. Sample rows never appear here.
- **Empty state:** a dashed 12px container with chips for the browser's own unregistered name (first), Laptop, Desktop and Phone, which register the fixed ids `laptop`, `desktop` and `phone` in either language.

### Storage Management
An independent, wider management column preserves the same ink controls, hairlines, typography and surfaces. It enters with the shared `settle` animation (0.55s, house ease), with the global reduced-motion override. The overview leads with the total stored size and one composition bar: prompt text and the rest of the database file (D1), then images and uploads awaiting cleanup (R2), each a share of the stored total. Segments are proportional with a 6px minimum, so a type that is a fraction of a percent stays visible; flexbox takes that width back from the larger segments, and the legend underneath gives exact sizes and shares. Hovering a segment or legend entry dims the others. D1 (10 GB) and R2 (no fixed limit) are separate platform limits, so they appear as two quota rows below the bar, and only the D1 row has a meter, which keeps a 3px sliver for any non-zero usage. No icons sit in the overview headings. The four prompt-data groups below are a different measurement and are not part of either chart.
- **Filters:** title/project search, status, expiration and sort remain visible. A native disclosure contains project, device, creation-age and byte-size filters. Presets change filters without selecting records.
- **Rows:** a metadata table on desktop becomes compact grid rows on mobile. Titles open protected plain-text previews. Selection uses 18px ink checkboxes with 5px corners, inset 12px on desktop and 10px on mobile. Selected row surfaces have 8px corners; focus rings stay clear of the table edge. Native checkbox rendering remains available in forced-colors mode.
- **Deletion:** a sticky rounded action bar shows the count and selected UTF-8 prompt data. A native modal focuses Cancel and explicitly names permanent deletion. Ready/Claimed selections add a caution. The meter is re-measured after deletion; no estimated bytes are subtracted from measured allocation.

### Notifications
Notifications are set up in Settings › Notifications and reminded of, only when there is something to do, by a chip in the inbox footer. Nothing is added to the top bar, no banner or dialog interrupts, and the browser's permission prompt only ever follows a click.
- **This browser:** a group in the 808px Settings column built like General: each row has its label and a one-line note on the left and its control on the right. The first row states the state as one sentence in words, never a coloured pill: *Off*, *On · for Laptop · last delivered 2 minutes ago*, *Blocked in this browser*, *Needs reconnecting*, a line for browsers that cannot use notifications, or *switched off on this Site* (only when the operator set `AGENTRELAY_WEB_PUSH_ENABLED=0`; a Site makes its own push keys, so there is no "not set up" state). Blocked, reconnecting and error read in Caution Amber; the other states stay in ink and grey. The button beside it is the one action that state allows: Turn on (primary), Reconnect (primary), Turn off, or none while blocked, where the note says how to unblock.
- **Options:** Notify for (the device this browser is bound to, a quiet native select), Notify about (Handoffs put back to Ready, on by default; Handoffs sent to Any device, off by default; new handoffs for the device are always included and said so in the note), Handoffs sent from here (a quiet native select: Off, When done (the default), When claimed and done; a handoff the device claims itself is never announced to it), Connection expiry (a quiet native select: Off, This device's connections, All connections; the note names the 7-day, 3-day, 1-day and 1-hour schedule and the information button holds the rules), Show title and project (a single checkbox at the right), then Test, which shows a real system notification even while the page is open. The options stay visible while notifications are off, disabled, so the person sees what they would get before granting permission; a disabled option's label turns grey. A change is saved as it is made; there is no Save button. The top-bar device picker never changes the binding, and the note says so.
- **Delivery details:** a native disclosure with the push service's last acceptance, the last error and the browser's own last receipt, and a note that *accepted* does not prove the system displayed anything.
- **Other browsers:** shown only when another browser notifies the workspace. A hairline list in the same column, one row per browser: its label, its device, who turned it on (by name) and when it last delivered, with a quiet Remove button. Addresses, keys and ids never reach the page. Removing one stops its notifications and a confirmation toast appears.
- **First test and checks:** turning on (or reconnecting) sends a test notification by itself. The note under the state then says it is on its way, followed by a folded *Didn't see it?* with the operating-system checks (Windows Do Not Disturb and notification settings, macOS Notifications and Focus, the browser staying open, the delivery details). A test from the Test row shows the same fold under its acknowledgement. Both go away after two minutes.
- **Unblocking:** a changed permission is read again as soon as it changes or the window regains focus, so the blocked note never asks for a reload.
- **Setup checklist step:** while the setup checklist shows, an optional *Get notified in this browser* row follows the four numbered steps: a bell instead of a number, a muted *Optional* tag, never counted in the progress and never the current step. It offers a quiet Turn on notifications button (the permission prompt follows that click only) and a link to Settings › Notifications; once on, it reads as done and names the device, with the test confirmation and a *Didn't see it?* link to Settings. It is absent wherever the Settings state is unsupported or not set up, and points to Settings when blocked or lapsed.
- **Footer reminder:** a quiet chip beside the storage chip and the sync state, in the footer's muted ink. It is hidden while notifications are on and in browsers that cannot use them. A browser that never turned them on shows a bell-off icon only, until the person has opened Settings › Notifications once; a blocked or lapsed browser shows an icon and a short word (*Notifications blocked*, *Reconnect notifications*) in Caution Amber, because that needs a decision.
- **Arrival notice:** when a push reaches a visible page the toast reads *New handoff: <title>* with an underlined *Open* action, stays eight seconds instead of four, and the inbox reads again at once. The toast takes the width of its content up to 520px, so a long message with an action never wraps in half the screen on a phone. An expiry reminder on a visible page uses the same toast with the reminder's own sentence and an *Open connections* action that shows the Agents page. A progress notice for a handoff sent from this device reads *Done on <device>: <title>* (or *Claimed on…*) with the same *Open* action.
- **Browsers:** v1 is verified on desktop Chrome and Edge only; every other browser, and every phone or tablet, sees the settings with every control disabled and one line saying so.

### Connections Stepper and Disclosure
Agent connections replace the token form. The wizard is four stations on a short horizontal strip (Device, Agent, Details, Set up; three for the Site's plugin, which issues no token): finished stops are filled ink, the current one is a ringed ink stop, the rest keep the Unreached Stop ring. The step heading takes focus on each change. Choices are 9px-corner tiles with a 1px border that darken to ink when chosen; the last step is numbered in the order of action: where to run it with the command's copy panel (which names the connection and carries no secret), the one-time token to paste with a folded note on the Site's gateway token, then a line that says whether the credential has authenticated yet with Refresh and Done. Hiding the token hides only the token. The wizard itself has no border, so no panel sits inside another.
- **Revoked and expired:** a native `<details>` closed by default, summarised as "Revoked & expired (n)". Rows are read-only and say when, by whom and why they ended ("Revoked 26 Oct 2026 · by Alex Kim · Its device was deleted"); expired rows and rows ended before this was recorded show only the date. Remove and Remove all each ask before deleting permanently.

### Connection List
The list answers who issued a connection, whether it is used and whether it needs a look, so state is written in words and grouped by the question being asked. Top to bottom in the Agents column: the New connection primary button with quiet Refresh and Activity buttons at the right; the attention banner, only when something needs a look; the toolbar, only with more than three active connections, more than one issuer, or a filter on; the selection bar, only while rows are ticked; the groups; Revoked & expired; then the notes (plugin connections are not listed here, and the gateway credential).
- **Group header:** a 9px dot, the name in 13px semibold Platform Graphite, a muted "n active", and a small secondary button at the right: *Revoke all n…* on the viewer's own member group, *Remove access…* on another member's, none under devices or agents. Member groups put the viewer first and mark them "(you)"; devices follow the registry order with "No device" last; agents follow the wizard's order with "Other or unknown" last.
- **Row:** a 16px ink checkbox, the name (14.5px, 550), the health word with its dot, and the agent badge; under it up to three muted 12.5px lines: who issued it (only when grouped by device), its lifetime ("Valid until 24 Jan 2027", "Permanent · can be revoked", or "Expires in 23 hours" in Caution Amber inside the last 14 days; read relative to now inside 60 days), and its last use ("Last used 3 minutes ago · Reports as codex-cli 0.42.1" or "Never used", with the exact time as the tooltip). At the right: the device select, Rename and Revoke as small secondary buttons, and a 34px overflow button. Revoke asks first in the usual confirm strip.
- **Health words:** *Pending setup* for the first 24 hours after creating or rotating a connection that has not been used, *Unused* after that, *Active* for use in the last 30 days, *Idle* beyond it. They describe use of the secret, never whether an agent is online.
- **Toolbar:** a search field and quiet selects (Issued by, only with more than one member; Device; Status) with 12px labels above, all 34px tall with 8px corners and the ink focus ring, then a segmented control (Member, Device, Agent) built like the status filter: Selected Tile track with 9px corners and 3px inset, surface thumb with the Thumb shadow. *Clear filters* appears as a quiet button while a filter is on. The grouping is remembered per browser; filters are not.
- **Attention banner:** the warning banner with the count and the reasons (never used, unused for 60 days, expiring within 14 days); *Review* applies the attention filter and never revokes anything.
- **Selection bar:** a Tile Wash band with a 1px Rule Line border and 10px corners: "n selected", the *Revoke selected…* button, and *Clear selection* at the right. Ticked rows that stop being usable drop out of the count.
- **Row menu:** the standard menu, 230px minimum: *Extend lifetime…*, *Rotate secret…* (disabled, with the reason as its tooltip, on a connection another member issued) and *Show setup command…*. The first enabled item takes focus; Escape closes the menu and returns focus to its button.
- **Phone (≤720px):** the toolbar and the row actions wrap, and menus and dialogs stay inside the viewport and the page never scrolls sideways (see the verification index).

### Connection Dialogs
Native modal dialogs on the compose dialog's surface (16px corners, Pop shadow, 45% ink backdrop): 540px wide, 600px for removing access, 640px for the setup command and the rotate dialog. A dialog that can destroy something opens with Cancel (or Close) focused, Escape closes it, and focus returns to the control that opened it, once the change has finished when that control is disabled meanwhile.
- **Revoke these connections?** The exact set as "name · device · Permanent", for a member's whole set or a selection; the confirm is the only Danger button. If the set changed in the meantime nothing is revoked and the list reloads.
- **Extend:** the current expiry, a lifetime select (30, 90, 365 days, Permanent) and *Set lifetime*. Choosing Permanent first opens the same risk acknowledgement as creating one.
- **Rotate:** says the old secret stops at once and *Rotate secret* is Danger. Afterwards the same dialog shows the new secret in a read-only field with a copy button, an agent select that starts on the connection's own agent, and the setup command. Only this dialog ever holds the secret: lists never carry it and closing the dialog removes it from the page.
- **Setup command:** an agent select and the command in a copy panel, with no secret.
- **Remove access:** the member's name, then three numbered steps with 24px ring numerals: remove them in Sites Sharing (with a local checkbox), revoke their exact active set (the only step that acts, with the Danger button), and rotate the gateway token if they had it (through Codex, then on each remaining device). Steps 1 and 3 are written as manual and unverifiable. After step 2 it becomes a status line and the dialog stays open for the other two; focus starts on Close, not on the Danger button.

### Activity Panel
A native modal side panel pinned to the right: 480px wide, or the viewport's width where that is narrower, full height, 16px left corners (square at ≤720px), Pop shadow. A header with the title and an icon close button (focused first), one muted line saying what is kept, then a hairline list, newest first. Each entry is a 14px sentence naming who did what ("Alex Kim revoked Sam's CI runner") with a muted relative time at the right and the exact time as its tooltip; names are plain text and entries keep a connection's name as it was. *Show older* loads the next 30.

## Do's and Don'ts

### Do:
- **Do** colour a route by its destination's registered line (`resolveStop`, falling back to `heuristicLine`) through `data-line`; let `--line` cascade to every part of the strip.
- **Do** keep chrome, focus outlines, selection, tabs and the primary button in ink.
- **Do** draw unreached stations with the Unreached Stop ring so they hold at least 3:1 against the surface.
- **Do** render prompt text as inert plain text in a `<pre>`, line by line, with the original whitespace preserved.
- **Do** play the route ride only while `data-moving` is set by a real status change, and keep every animation under the global `prefers-reduced-motion` override.
- **Do** use the house ease `cubic-bezier(0.16, 1, 0.3, 1)` for entrances and the ride; keep entrance fades between 0.22s and 0.6s.
- **Do** show device names exactly as registered; they are data. A route whose device was deleted shows the name stored on the handoff.
- **Do** separate regions with hairlines and tonal tiles.
- **Do** keep one-time secrets out of every list: a secret appears only in the dialog that made it and leaves the page when that dialog closes. Screenshots and test captures hide it too.
- **Do** open a destructive dialog on its Cancel or Close button, never on the destructive one, and give focus back to the control that opened it.
- **Do** ask the browser for notification permission only from a click on Turn on or Reconnect, never on page load, and never again once it is blocked.
- **Do** say what a notification state means in a sentence and give the one action that fits it; show the options of a state that is off, disabled.

### Don't:
- **Don't** render prompt content with `dangerouslySetInnerHTML`, Markdown, syntax highlighting or any HTML parsing.
- **Don't** use a line colour to decorate, to signal success or warning, or to style focus, selection or chrome.
- **Don't** draw a handoff's status as coloured pills or badges; status is the train's position on the line. (A connection's health is the exception that proves the rule: a dot and a word, never a fill.)
- **Don't** nest a card inside a card or put a bordered panel inside another panel.
- **Don't** add eyebrow or kicker labels above headings.
- **Don't** translate, rename or re-case device names when the interface language changes. The one exception is the reserved "Any device" target, whose label follows the interface language.
- **Don't** animate the route on mount, on selection change or on a theme or language switch.
- **Don't** add ornament beyond strokes and round station dots: no gradients, illustrations or decorative icons.
- **Don't** give a resting surface the Pop shadow.
- **Don't** present what an agent reports about itself as fact. "Reports as…" is muted text, never a badge, and nothing in the interface or the server changes what a connection can do because of it.
- **Don't** show "accepted by the push service" as if the notification had been displayed, or draw a notification state as a coloured pill or badge.
- **Don't** let a manual step look automatic. When part of a task happens outside AgentRelay (Sites Sharing, the gateway token), the dialog says so and says it cannot check it.
