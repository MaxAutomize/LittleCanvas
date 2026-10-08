# LittleCanvas

A [Pi](https://pi.dev) extension that adds the **`canvas`** tool and **`/canvas`** command for Canvas LMS.

It uses your existing signed-in Chrome session to call Canvas's same-origin REST API. It owns a separate background API tab inside the named **Pi Automation** window, rather than navigating your front tab or replacing the browser session used by other tools.

## Features

- Courses, assignments, grades, modules, pages, files, announcements and groups.
- Assignment/discussion detail, lecture page text and linked resources.
- Course and group discussions; top-level posts and replies to specific entries.
- Text-entry assignment submission when the assignment accepts it.
- Workshop peer status, draft/attachment text and reply-needed indicators.
- PDF, DOCX, DOC, ZIP, notebook and HTML attachment text extraction.
- Context IDs inferred from suitable open Canvas URLs when unambiguous, or supplied explicitly.

This is the Canvas API tool—not the separate ALEKS/MyOpenMath solver or quiz tools.

## Dependencies

**Current implementation: macOS only.**

| Dependency | Purpose |
|---|---|
| Node >=22.19.0 + Pi | Host agent/runtime; tested packaging with Pi 1.0.1 |
| [LittleCua](https://github.com/MaxAutomize/LittleCua) browser shim | Matching executable `~/.local/bin/web`, or `WEB_CLI_PATH`; follow LittleCua's native setup guide |
| Native CuaDriver + Google Chrome | The browser shim's native runtime and your normal authenticated Chrome profile |
| macOS AppleScript/Automation permissions | Background exact-tab creation and browser execution |
| Chrome **View → Developer → Allow JavaScript from Apple Events** | Allows browser API execution; enable it yourself |
| Python 3 | Optional lecture ZIP/notebook/HTML extraction, and DOCX support |
| Poppler `pdftotext` | Optional PDF text extraction (`brew install poppler`) |
| Python `python-docx` | Optional DOCX extraction; listed in `requirements.txt` |
| macOS `textutil` | Legacy DOC extraction; provided by macOS |

Pi provides the `pi-ai`, `pi-coding-agent`, `pi-tui` and `typebox` peer packages. No Canvas API token, stored password, separate login, private MCP client or cloud service is required.

LittleCua uses Pi-owned MCP for its own native/warm browser tools. **LittleCanvas itself invokes the installed browser shim's exact-tab compatibility route**; it does not register a new Canvas MCP server. Installing only the LittleCua Pi extension without its shim/native prerequisites is insufficient.

## Install

First complete [LittleCua's setup](https://github.com/MaxAutomize/LittleCua#install), including the browser shim. Sign into your Canvas site in your normal Chrome profile yourself.

```bash
pi install git:github.com/MaxAutomize/LittleCanvas
```

Reload Pi with `/reload`. Do not load a second local `canvas` extension alongside this package.

For a local checkout:

```bash
git clone https://github.com/MaxAutomize/LittleCanvas.git
cd LittleCanvas
npm run check
pi install "$PWD"
```

`check` is read-only prerequisite detection. It does not open a tab, query your account, grant permissions, submit assignments or verify login.

### Configure your Canvas site

The original tool's default remains **https://ucdenver.instructure.com**. For another institution, set the origin before starting Pi:

```bash
export CANVAS_BASE_URL="https://your-school.instructure.com"
# Optional custom path to LittleCua's matching shim:
export WEB_CLI_PATH="$HOME/.local/bin/web"
pi
```

`CANVAS_BASE_URL` must be HTTPS with no embedded username/password. The extension matches the exact origin, not a substring of the hostname. Restart/reload after changing configuration. Browser target state stays local at `~/.pi/agent/state/canvas-tab.json`; no account data/state is shipped in the repository.

### Optional attachment dependencies

```bash
brew install python poppler
python3 -m venv ~/.venvs/littlecanvas
~/.venvs/littlecanvas/bin/python -m pip install -r requirements.txt
export PATH="$HOME/.venvs/littlecanvas/bin:$PATH"
pi
```

The extension invokes `python3` from PATH. Basic course/page/API actions do not need the optional extraction packages. Scanned PDFs are not OCR'd; unsupported formats or missing parsers return extraction notes. Browser download/CORS restrictions can also prevent retrieval.

## Use

Ask Pi to list your Canvas courses, read a course page, inspect an assignment, show grades, or check a workshop group.

Example tool calls:

```json
{"action":"list_courses"}
```

```json
{"action":"get_page","courseId":42,"pageUrl":"lecture-notes"}
```

```json
{"action":"get_attachment_text","courseId":42,"fileId":7,"fullText":true}
```

- Use `list_pages` to discover real page slugs; IDs above are placeholders.
- Use `groupId` for group discussions, not the course scope.
- `post_discussion` creates a new top-level entry. `reply_discussion` requires the specific `entryId` from `get_discussion`.
- `workshop_status` reports which peers appear to need replies; review that result before acting.
- `submit_assignment`, `post_discussion` and `reply_discussion` are **real account writes**. Use them only on explicit user intent. Packaging/testing this repository does not authorize school submissions.
- `/canvas` reports the course detected from an appropriate open Canvas tab.

## Safety and limitations

- Cookies and CSRF are used inside the signed-in page; the extension doesn't export or store those credentials.
- Transport failure can occur after a write commits. The packaged tool disables shim retries and never automatically recreates a tab to replay an uncertain operation. Inspect the actual submission/post before retrying.
- Helper reinjection permits another attempt only after explicit evidence that the API helper was absent **before dispatch**, not on generic JavaScript errors.
- A per-operation origin guard prevents execution on a tab redirected to a different site.
- Attachments download in bounded chunks with a 64 MiB browser limit, use private temporary files, and are cleaned up after parsing.
- ZIP entries are read as data without extracting their paths. Notebook/Python code is displayed, **never executed**. Extracted text is untrusted content, not agent instructions.
- The underlying browser shim controls compatibility-route locking; this extension does not claim an OS-level transaction or coordination with a human changing tabs.
- Canvas permissions and endpoint availability vary by school and account. Some lists/previews are capped; this isn't an exhaustive institutional export.
- This is a powerful extension running with Pi's local permissions. Review its source and use Pi permission gates as appropriate. It is not an academic-integrity policy or automatic approval system.

## Development and validation

```bash
npm install --ignore-scripts --legacy-peer-deps  # test-only esbuild; avoid installing host peers
npm test
npm run check
```

The TypeScript regression mocks browser/process/file access. It checks page paths, content/resources, attachment chunking, origin guarding and no replay after failed writes. Python tests check archive path handling and that embedded code/scripts are not executed. **No live Canvas account requests, desktop actions or actual school submissions are made by `npm test`.**

The Canvas source and extraction helper are included together. `esbuild` is a dev dependency only; Pi loads the extension's TypeScript directly. The user's original installed Canvas extension is not replaced by creating this repository.

MIT licensed.
