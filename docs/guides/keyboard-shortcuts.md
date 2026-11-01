# Keyboard shortcuts

Press `?`, or use **Settings › Keyboard › Show all shortcuts**, to view shortcuts in the current interface language. Single-key shortcuts start enabled; **Settings › Keyboard** can disable them for this browser. The preference survives reloads and also updates other open tabs. If browser storage is unavailable, the switch still works for the current session.

| Key | Action |
| --- | --- |
| `1` / `2` / `3` / `4` / `5` | Switch to Inbox / Done / Devices / Agents, or open Settings. `2` opens Done; it does not complete a handoff. |
| `/` | Focus search in Inbox or Done. On a narrow detail view, return to the list first without resetting filters. |
| `N` | Open a new handoff with title focus. |
| `J` / `K` | Select the next / previous filtered handoff, stopping at either end. Desktop previews update immediately; narrow screens stay on the list. |
| `Enter` | Open the focused list row and focus the prompt. |
| `Y` | Copy the complete prompt when its detail pane is visible. |
| `Shift+C` | Claim the selected Ready handoff while its detail is visible. |
| `Shift+D` | Complete the selected Claimed handoff while its detail is visible. |
| `Ctrl+Z` / `Cmd+Z` | Undo your last claim or completion in this tab. |
| `Ctrl+Enter` / `Cmd+Enter` | Send from the new handoff form, retaining required-field validation. |
| `?` | Open shortcut help. |
| `Esc` | Dismiss the current layer, leave search, or return from narrow detail to the list. |

Character shortcuts are inactive in inputs, textareas, selects, editable content, and textbox/combobox controls. Composition events, legacy IME key events, held-key repeats, and unrelated modifier chords are ignored. Modal dialogs, detail menus, and delete confirmations block background shortcuts. Ordinary browser copying, text editing, arrow-key scrolling, and textarea newlines keep their native behavior.

Claim and complete are separate actions: neither advances a handoff through both states. Shift is required; Caps Lock alone does not activate either action. Both follow the single-key preference, are disabled in sample mode and while a mutation is pending, and use the same version-checked operation as the buttons. They act on a row you picked with `J`/`K`, a pointer or a link, or on a detail that holds focus; focus may stay on the list row. The fallback preview shown after a status change removes the selected row was not picked, so repeating a key cannot act on it: pick that row or focus its detail first. If a status change removes that row from the current filtered list, focus returns to the list (or search when empty), including on narrow screens. Conflicts refresh the list without retrying the mutation. A still-visible claimed handoff keeps prompt focus for copying.

`Ctrl+Z` / `Cmd+Z` (also the toast's **Undo** button) steps the handoff you last claimed or completed back one state, whichever row is selected now: a claim returns to Ready and clears its claimant, and a completion returns to Claimed with its original claimant. Undo is one step deep, is sent with the version that action produced, and is refused once another device or agent has changed that handoff. An undone claim does not send a requeue notification. Like `Ctrl+Enter` it works when single-key shortcuts are off, and text fields keep their own undo. Agents cannot undo: the MCP tools keep the forward-only transitions.

In search, the first Escape clears a nonempty query; another Escape returns focus to the selected row. Escape closes only the top interaction layer. In a narrow detail view, a subsequent Escape returns to the selected list row. Desktop detail stays open.

A clean new-handoff form closes immediately. If any field differs from its initial value, Escape, the close button, and the backdrop ask whether to discard changes. Continue editing is focused by default; Escape in this confirmation returns to editing with all fields intact. Only the explicit discard button abandons those changes. Sending disables closing and duplicate submission; failure retains the form and request key, and success focuses the new prompt. This confirmation does not save drafts across reloads or navigation away from the page.

## Verification

Start the production Worker preview using the README instructions, then run:

```bash
export AGENTRELAY_TEST_URL=http://127.0.0.1:5178
npm run test:e2e:keyboard
```

```powershell
$env:AGENTRELAY_TEST_URL = 'http://127.0.0.1:5178'
npm run test:e2e:keyboard
```

The suite requires the separately installed `agent-browser` CLI. On Windows it defaults to the npm global native executable; elsewhere it uses `agent-browser` on PATH. Set `AGENT_BROWSER_BIN` to an absolute executable path when installed elsewhere. Set `AGENTRELAY_QA_OUTPUT` to choose the evidence directory.

The suite rejects remote hosts, creates a disposable authenticated owner, and cleans up that owner's handoffs. It exercises real browser key events and real local HTTP/D1 creation, with controlled clipboard, IME, and network-failure probes for paths that are otherwise nondeterministic. Captures cover desktop and narrow layouts, help, discard confirmation, and Chinese dark mode. Simulating Meta on Chromium verifies the handler; physical macOS, assistive technology, and real IME candidate-window behavior require separate device checks.
