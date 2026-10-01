# Harness Widget

**English** · [Русский](README.md)

A compact always-on-top window shell for an **already running** DeepSeek Harness web host.

The widget does not start its own Harness and does not replace it: it connects to the same
server (`http://127.0.0.1:3080`), so the profile, session list, history and the current
conversation are exactly the same as when working in a browser. Just without the browser:
a narrow panel at the right edge of the screen, above other windows, with a tray icon and a
global hotkey.

## Requirements

- Windows 10 or 11 (tested on Windows 11 26200). Background transparency requires Windows
  transparency effects to be enabled: *Settings → Personalisation → Colours → Transparency effects*.
- Node.js 18+ and npm — only to install the dependency.
- A running Harness reachable at `127.0.0.1:3080` (`npx @deepseek-ai/dsh web`).
  The widget does not start or stop it unless a launcher path is configured.

## Installation

```powershell
git clone <this repository URL> HarnessWidget
cd HarnessWidget
npm install
copy config.example.json config.json   # then adjust the values to your liking
```

If `npm install` hangs while downloading the Electron binary, download the archive manually and
unpack it into `node_modules\electron\dist`, placing a `path.txt` file next to it containing the
line `electron.exe`. That is exactly how Electron was installed for this project.

## Running

```powershell
npm start
```

Or double-click `Start-Widget.cmd`. The window opens as a panel at the right edge of the screen.

## Controls

| Action | How |
|---|---|
| Show / hide | `Ctrl+Space` (configurable) or a click on the tray icon |
| Compact panel / full window | a button in the header or a tray menu item |
| Always on top | the “pin” button in the header |
| Reload the page | the “⟳” button in the header |
| Hide to tray | the “✕” button in the header |
| Quit | tray menu → “Quit” |
| Start / stop the Harness | tray menu (calls the launcher’s `Start-Harness.ps1` / `Stop-Harness.ps1`) |

The window is frameless: the widget header is its own and can be dragged with the mouse.
The size and position of the free window are remembered between runs.

## Settings

The gear button in the widget header opens the settings window, “Interface” section:

| Setting | What it does |
|---|---|
| Panel width | Slider 320–900 px; the window changes width immediately |
| Panel height | Slider 15–100 % of the work area height |
| Frosted background | Blurred backdrop behind the window (Acrylic). A switch |
| Background transparency | How much of the backdrop the panel lets through, 0–85 % |
| Card transparency | The input field and message cards: they are always denser than the background |
| Appearance animation | The window slides in from the right edge and slides back out |
| Pop up on agent answer | Shows the window when the agent has finished answering |
| Windows notification | A toast in the corner of the screen when the answer is ready — visible even in a fullscreen game |
| Notification sound | A sound alongside the toast |
| Start typing hotkey | A second combination: open the widget and focus the input field |
| Launcher folder | Where the Harness address and the launch scripts live |
| Harness address | An explicit address; empty — taken from the launcher state |
| Window position | “Return to place” button — resets to the right edge of the screen |
| Hotkey | Show and hide the widget from anywhere |
| Menu font | Scale of the session menu, 60–200 % |
| Model dialog font | Scale of the model picker popup, 60–200 % |

Changes apply immediately and are saved to `config.json`. The “Reset” button restores the
defaults, `Esc` closes the settings window.

### Window position and size

The widget remembers the geometry you set yourself — by dragging the header or resizing the
window edges in Windows. Close it and open it with the hotkey: the window returns to the same
place at the same size. The position is stored in
`%APPDATA%\harness-widget\window-state.json`.

There are two cases where the remembered position is deliberately forgotten:

- moving the “Panel width” and “Panel height” sliders — that is an explicit size instruction,
  and it takes precedence over the manual adjustment;
- the “Return to place” button in the settings, or the tray menu item “Return the panel to the
  right edge”.

If the monitor the window was on has been disconnected, the bounds are validated and fitted to
the remaining screens.

### Appearance animation

When showing, the window slides in from the right edge of the screen; when hiding, it slides
back out. Only the position moves and the size stays the same, so the layout is never
recalculated and the motion is smooth. The duration is 240 ms with easing towards the end.

It can be turned off with the “Appearance animation” switch in the settings; the window then
appears and disappears instantly.

### Hotkey

A button showing the combination lives in the “Interface” section: click it, then press the new
combination — it applies immediately. `Esc` cancels the recording, `Backspace` restores the
default.

Combinations with a modifier (`Ctrl`, `Alt`, `Shift`, `Win`) or the function keys `F1`–`F24` are
accepted: single letters and digits are not, because such a combination would intercept ordinary
typing. If the combination is taken by another program, the widget says so and keeps the previous
one.

### Frosted background

The panel is drawn over the system window material: DWM blurs whatever is behind it. Two sliders
define the tint over the glass: “Background transparency” for the panel itself and “Card
transparency” for the input card — it is always denser than the background so the text stays
readable. Menus and popup panels remain opaque.

The glass is visible only as far as what is behind it is contrasty. Over a flat dark backdrop
there is nothing to blur — the panel will simply look dark. The effect shows up when there are
bright or colourful windows behind the widget.

Two conditions without which the glass will not be visible:

1. **Windows 11 22H2 or newer** — the Acrylic material is supported only there.
2. **Windows transparency effects enabled**: Settings → Personalisation → Colours →
   Transparency effects.

Toggling the mode recreates the window: window transparency can only be set when the window is
created, so the page reloads. The session lives on the server and comes back in place.

## File configuration

`config.json` next to `package.json`:

```jsonc
{
  "launcherDir": "F:\\Automatic Harness Runner", // where to take the token and launch scripts from
  "url": "",                                     // explicit address; empty — take it from the launcher state
  "hotkey": "Control+Alt+H",
  "panelWidth": 440,                             // compact panel width, px
  "panelHeightRatio": 0.3333,                    // panel height as a share of the work area (1/3 of the screen)
  "zoomPanel": 1.6,                              // UI scale inside the panel (0.8 is the original)
  "zoomWindow": 1,                               // UI scale in the full window
  "menuScale": 1,                                // session menu scale
  "modelScale": 1,                               // model picker dialog scale
    "showOnStartup": false,                        // open the window immediately at Windows sign-in
  "popupOnAnswer": true,                          // pop up when the agent has finished answering
"alwaysOnTop": true
}
```

The settings window edits the same values, so the file can be left alone.

The panel is docked to the bottom-right corner. `panelHeightRatio` changes the height: `0.5` is
half the screen, `1` is the full height.

## Harness UI cosmetics

The file `src/widget.css` is applied to the page inside the widget and does not affect the
browser. It currently contains the following adjustments:

- the input field is stretched to the full panel width and sits exactly in the centre;
- the input field is lifted from the bottom edge: the bottom gap is 1.5 times smaller than the
  side gap;
- the placeholder inside the input field is removed;
- the input field is compact when empty and grows with the typed text (minimum 28 px — a single
  line; past 336 px the container starts to scroll);
- in an empty session the decorative header (the large logo and the mode row) is hidden: at the
  increased scale it prevented the input card from fitting into the panel;
- the model picker group is pushed to the right and wraps onto its own row when it no longer
  fits; the button itself shows a badge in the style of the neighbouring row icons — muted text
  and a thin outline instead of a fill: the model tier (`FLASH`, `PRO`, otherwise a code such as
  `V41`) and the reasoning mode letter in an outlined circle — `O` off, `L` low, `H` high,
  `M` maximum; the full model name is in the hover tooltip;
- the Harness settings panel and its pages (Plugins and others) get their natural size: at a
  large page scale their layout did not fit the widget panel and the text broke mid-word. The
  scale is compensated, the pages fill the whole window width and height, while the conversation
  keeps the increased scale;
- conversation cards and bubbles are translucent, and the density is defined in CSS so a card
  never flickers opaque. Glass is allowed only in the conversation feed and in the input field;
  the script forces everything else to be opaque. This does not depend on class names: any
  Harness panel, menu or tooltip stays readable. On top of that, popup containers and their
  background layers are marked (in the Harness the menu background is a separate element with
  45 % opacity). Code blocks, editors and input fields are opaque as well;
- the file-diff popup card is widened to the full window width and pinned to the left edge: the
  stock 244 px were not enough and diff lines were cut off. Its background is opaque and the
  diff font is 10 px, so lines fit entirely and stay readable. Popups are excluded from the
  transparency rules altogether: they must be opaque;
- the expanded session menu floats above the content like a drawer: in a narrow panel the menu
  column took almost the whole width and broke the pages. It closes on a click anywhere outside
  the menu (on the chat) or with `Esc`, not only via the button; the closing click is swallowed
  so that it does not also hit the content under the menu;
- the left icon rail is removed: the content takes the full width and only the DeepSeek logo
  remains in the top-left corner. Clicking it expands the session sidebar (it is the stock toggle
  button). The rail is drawn as an overlay and does not capture the mouse — only the logo button
  is clickable, the rest of the strip passes clicks through to the content;

The page scale is set in `config.json`: `zoomPanel` for the compact panel and `zoomWindow` for the
full window. The value is a multiplier of the 100 % size: at `1.6` the interface is drawn twice as
large as the original `0.8`.

The selectors use CSS-module suffixes (`[class*="_composerSeat"]`), so they survive a frontend
rebuild. The sidebar state is recognised by the `_collapsed` marker on its root: the hidden-rail
rules apply only when collapsed; when expanded, the sidebar opens normally.

The window state (mode, sizes, pinning) is stored in
`%APPDATA%\harness-widget\window-state.json`.

## How authorisation works

The Harness accepts the token only on `GET /`, after which it sets a signed cookie for 30 days and
redirects to a clean address. On every connection the widget reads the fresh tokenised address
from the launcher’s `state/harness.json`, so re-authorisation happens automatically after the
Harness restarts. If the server has not come up yet, the widget shows a placeholder and retries
every 5 seconds.

## Autostart

Tray menu → “Start at Windows sign-in”. The widget is registered in the user’s startup entries
(the `HKCU\...\CurrentVersion\Run` registry key) with the `--hidden` flag: on sign-in it starts
**hidden and waits in the tray** without opening a window. From there the global hotkey
(`Ctrl+Space` by default) or a click on the tray icon brings it up.

If you want the window to open immediately at sign-in, enable “Open at sign-in too” in the tray
menu — the `--hidden` flag is then removed from the startup entry.

To disable autostart, clear the checkbox on the same menu item. Alternatively, create a shortcut
to `node_modules\electron\dist\electron.exe` with the widget folder path and `--hidden` as
arguments.

You can verify what was written like this:

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
  Select-Object -ExpandProperty 'electron.app.Electron'
```

## Layout

```text
src/main.js            main process: window, tray, hotkey, authorisation, launcher integration
src/toolbar.html       the widget's own header (drag area, buttons, server indicator)
src/settings.html      settings window: interface, font, hotkey
src/widget.css         visual adjustments to the Harness page inside the widget
src/widget.js          page skin script: model badge, glass, panel behaviour
src/preload-*.js       bridges: header, Harness page, settings window
src/offline.html       “server is not responding” placeholder
tools/make-icon.js     generates assets/icon.png for the tray
assets/icon.png        tray icon (generated)
```

## Third-party resources

Nothing beyond the list below is used in the project: there are no bundled fonts, icons or
images, and every asset is drawn in code.

| Resource | Where it is used | Licence / status |
|---|---|---|
| [Electron](https://www.electronjs.org/) 44.5.1 | The only dependency. Window runtime: `BaseWindow`, `WebContentsView`, tray, global hotkeys, system window material | MIT |
| [Node.js](https://nodejs.org/) 18+ and npm | Running the widget and installing the dependency. At runtime only the built-in `node:path`/`node:fs` modules are used | MIT |
| [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) | **Not distributed** with the widget and not one of its dependencies. The widget connects to an already running local Harness web host, exactly as a browser does | © DeepSeek, licence of the Harness project |
| [npmmirror](https://npmmirror.com/mirrors/electron/) | A mirror from which the Electron binary was downloaded manually once (the npm installer hung). Not used in the project code | Public mirror |
| Windows DWM (`DwmGetWindowAttribute`, system window materials) | Window background blur/transparency and material diagnostics | Windows system API |
| Windows system fonts | All widget typography. The project ships no fonts of its own | System |

**A note on styling.** The widget adjusts the appearance of the Harness page by addressing its
interface CSS classes through module suffixes (`[class*="_composerSeat"]` and the like). This is
not a library and not a fork: the Harness code is neither copied nor redistributed. The hashes in
those classes belong to the Harness build and may change in a new version — part of the cosmetics
would then stop applying until the selectors are updated.

The tray icon is generated by `tools/make-icon.js` using Canvas primitives — there are no
third-party graphics files in the repository.

## Popping up on an agent answer

The widget pops up **only when the whole turn is finished**, not on every pause between steps.
The signal is the “N turns” counter in the statistics row under the conversation: it grows when the
agent completes a turn and is not affected by transcript virtualisation. While the agent is thinking
or calling tools the window stays hidden — otherwise it would pop up several times per answer.

If that counter is missing from the markup there is a fallback: a minute of silence with the send
button back also counts as a finished turn.

It works together with autostart: the widget starts hidden, waits in the tray and appears the
moment the agent finishes, or on the global hotkey.

It can be turned off with the “Pop up on agent answer” switch in the settings.

## Tray state and notifications

The tray icon shows the agent state without opening the window:

| Icon | Meaning |
|---|---|
| Plain | The agent is idle |
| With an amber dot | The agent is working on an answer |
| With a green dot | The answer is ready and waiting |

Once the window gets focus, the green dot turns back to plain. The tooltip carries the session
name and, while the agent is working, the elapsed time. The tray menu offers **Stop the agent**
(enabled only while it works), **Settings** and **Open log**.

If an answer arrives while the window was hidden, the widget pops up and additionally shows a
**Windows notification** carrying the first lines of the answer — often enough to get the gist at a
glance. Clicking the notification opens the widget and puts the caret straight into the input
field. Both the field. Both the notification and its sound can be turned off with separate switches in the settings.

The widget registers itself in Windows as **“Harness Widget”** — with its own application ID and
a Start Menu shortcut. That is what makes a click on the notification go to the already running
widget instead of launching a fresh Electron process: no second window appears, the widget simply
slides out from the edge.

## Log and recovery

The widget writes its output to `%APPDATA%\harness-widget\widget.log` — the console is invisible
when launched through `.cmd`, so without a log there is nothing to debug with. The file is trimmed
so it cannot grow forever, and it can be opened from the tray menu.

If the Harness restarts, the widget checks the address every 15 seconds and reconnects on its own as
soon as the server responds again.

## Portable build

The widget can be built into a folder that runs without Node.js and npm:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1
```

It produces `dist\HarnessWidget\` with the Electron runtime inside and
`dist\HarnessWidget-portable.zip`. Two commands are included: `HarnessWidget.cmd` for a normal
launch and `Автозапуск.cmd` to register Windows autostart with tray waiting.

The archive is about 100 MB: most of it is Electron itself.

**About the Windows warning.** The build is not code-signed, so SmartScreen may show "Unknown
publisher" on first launch. Signing requires a paid certificate, so it is more honest to warn
about it here than to promise a signed installer.

## Limitations

- **No Harness — no widget.** The widget has no copy of its own: it only connects to the local
  server.
- **Transparency.** Full Windows window transparency is only possible with the system transparency
  effects enabled. Background blur (the “Acrylic” option) adds its own dark tint, which is why it
  is off by default.
- **Collapsing the right panel** takes about 350 ms — that is the Harness animation itself; the
  widget shows the conversation as soon as it finishes.
- **Screen capture** by third-party tools (GDI) cannot see the window when a game is running on
  top of it in exclusive fullscreen mode. This does not affect the widget itself.
- **Windows only.** Window materials and part of the behaviour are tied to Windows; the code has
  not been tested on other platforms.

## Licence

Version history — [CHANGELOG.md](CHANGELOG.md).

MIT — see [LICENSE](LICENSE). The project is not affiliated with DeepSeek; “DeepSeek” and the
logo belong to their respective owners.









