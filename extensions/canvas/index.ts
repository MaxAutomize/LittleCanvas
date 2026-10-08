/**
 * Canvas LMS Tool - Control your configured Canvas instance via browser API
 *
 * Uses Chrome's existing session cookies via `web run` to call Canvas REST API.
 * Requires: Chrome open and logged into Canvas.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// --- Canvas API helpers via web run ---

/** Strip the cua-driver markdown wrapper: ## Result\n\n```\n...\n``` */
function stripCuaOutput(raw: string): string {
  // Try to extract content from code block
  const codeBlockMatch = raw.match(/```[\s\S]*?\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // Fallback: just trim
  return raw.trim();
}

const WEB_BIN = process.env.WEB_CLI_PATH || (existsSync(join(homedir(), ".local", "bin", "web")) ? join(homedir(), ".local", "bin", "web") : "web");
const canvasBase = new URL(process.env.CANVAS_BASE_URL || "https://ucdenver.instructure.com");
if (canvasBase.protocol !== "https:" || canvasBase.username || canvasBase.password) {
  throw new Error("CANVAS_BASE_URL must be an HTTPS Canvas URL without embedded credentials.");
}
const CANVAS_ORIGIN = canvasBase.origin;
const CANVAS_HOME = `${CANVAS_ORIGIN}/?pi_canvas_api=1`;
function isCanvasUrl(url: string): boolean {
  try { return new URL(url).origin === CANVAS_ORIGIN; } catch { return false; }
}
const CANVAS_TAB_STATE = join(homedir(), ".pi", "agent", "state", "canvas-tab.json");

let _canvasTarget: string | undefined;
let _canvasTabCheckedAt = 0;
let _helperLoaded = false;

/** Run the user's updated web CLI without shell quoting or the active user tab. */
function webCmd(args: string[], timeout = 20_000, throwOnError = false): string {
  try {
    const result = execFileSync(WEB_BIN, args, {
      timeout,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      // A lost response may follow a committed POST. Never replay it in the shim.
      env: { ...process.env, WEB_RUN_RETRIES: "1" },
    });
    return stripCuaOutput(result).trim();
  } catch (error: any) {
    if (throwOnError) {
      const detail = String(error?.stderr || error?.stdout || error?.message || "unknown web error").trim().slice(0, 1000);
      throw new Error(`web ${args.join(" ")} failed: ${detail}`);
    }
    return "";
  }
}

function readSavedCanvasTarget(): string | undefined {
  try {
    const state = JSON.parse(readFileSync(CANVAS_TAB_STATE, "utf8"));
    return typeof state?.target === "string" && /^tab:\d+$/.test(state.target) ? state.target : undefined;
  } catch {
    return undefined;
  }
}

function saveCanvasTarget(target: string): void {
  mkdirSync(dirname(CANVAS_TAB_STATE), { recursive: true });
  writeFileSync(CANVAS_TAB_STATE, JSON.stringify({ target, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

function clearCanvasTarget(): void {
  _canvasTarget = undefined;
  _canvasTabCheckedAt = 0;
  _helperLoaded = false;
  try { unlinkSync(CANVAS_TAB_STATE); } catch {}
}

function targetCanvasUrl(target: string): string {
  return webCmd(["--tab", target, "url"], 8_000);
}

/** Create a dedicated background Canvas API tab inside the named Pi Automation
 * window without changing its remembered session tab or the user's front tab. */
function createCanvasApiTab(): string {
  const sessionRaw = webCmd(["session"], 15_000, true);
  let session: any;
  try { session = JSON.parse(sessionRaw); } catch { throw new Error(`web session returned invalid JSON: ${sessionRaw.slice(0, 300)}`); }
  if (!session?.windowId) throw new Error("The Pi Automation Chrome window could not be resolved.");

  const script = `on run argv
  set wantedWindow to item 1 of argv
  set targetUrl to item 2 of argv
  set rememberedTab to item 3 of argv
  tell application "Google Chrome"
    set botWindow to missing value
    repeat with w in windows
      if (id of w as text) is wantedWindow then
        set botWindow to w
        exit repeat
      end if
    end repeat
    if botWindow is missing value then error "Pi Automation window not found"
    tell botWindow to set newTab to make new tab at end of tabs with properties {URL:targetUrl}
    set tabIndex to 0
    repeat with t in tabs of botWindow
      set tabIndex to tabIndex + 1
      if (id of t as text) = rememberedTab then
        set active tab index of botWindow to tabIndex
        exit repeat
      end if
    end repeat
    return id of newTab as text
  end tell
end run`;
  const tabId = execFileSync("osascript", ["-e", script, String(session.windowId), CANVAS_HOME, String(session.tabId)], {
    timeout: 10_000,
    encoding: "utf-8",
  }).trim();
  if (!/^\d+$/.test(tabId)) throw new Error(`Could not create the Canvas background tab: ${tabId}`);
  // Chrome makes a newly created tab active after the creation event finishes,
  // so restore the remembered bot-session tab in a separate AppleScript call.
  try {
    execFileSync("osascript", ["-e", `on run argv
  set wantedWindow to item 1 of argv
  set wantedTab to item 2 of argv
  tell application "Google Chrome"
    repeat with w in windows
      if (id of w as text) = wantedWindow then
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          if (id of t as text) = wantedTab then
            set active tab index of w to tabIndex
            return
          end if
        end repeat
      end if
    end repeat
  end tell
end run`, String(session.windowId), String(session.tabId)], { timeout: 5_000, encoding: "utf-8" });
  } catch {}
  const target = `tab:${tabId}`;
  saveCanvasTarget(target);
  return target;
}

/** Resolve the extension's own pinned Canvas tab. This never switches or
 * rebinds the main Pi Automation session, so MyOpenMath and the user can keep
 * working in other tabs at the same time. */
function ensureCanvasTab(force = false): string {
  const now = Date.now();
  if (!force && _canvasTarget && now - _canvasTabCheckedAt < 20_000) return _canvasTarget;

  let target = _canvasTarget || readSavedCanvasTarget();
  if (target) {
    const url = targetCanvasUrl(target);
    if (isCanvasUrl(url)) {
      _canvasTarget = target;
      _canvasTabCheckedAt = now;
      return target;
    }
    clearCanvasTarget();
  }

  target = createCanvasApiTab();
  let lastUrl = "";
  for (let attempt = 0; attempt < 120; attempt++) {
    lastUrl = targetCanvasUrl(target);
    if (isCanvasUrl(lastUrl)) {
      const ready = webCmd(["--tab", target, "wait", "10000"], 15_000);
      if (ready.includes('"ready":true') || ready.includes('"state":"complete"')) {
        _canvasTarget = target;
        _canvasTabCheckedAt = Date.now();
        return target;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  clearCanvasTarget();
  throw new Error(`Canvas background tab did not load. Last URL: ${lastUrl || "unavailable"}. Make sure Chrome is logged into Canvas.`);
}

function rawWebRun(target: string, js: string): string {
  const guarded = `(function(){ if (location.origin !== ${JSON.stringify(CANVAS_ORIGIN)}) throw new Error("Canvas target origin changed; no operation dispatched"); return (0,eval)(${JSON.stringify(js)}); })()`;
  const b64 = Buffer.from(guarded, "utf-8").toString("base64");
  return webCmd(["--tab", target, "run", `eval(decodeURIComponent(escape(atob("${b64}"))))`], 60_000, true);
}

function webRun(js: string): string {
  const target = ensureCanvasTab();
  try {
    return rawWebRun(target, js);
  } catch (error) {
    // Preserve the target for read-only diagnosis. Never recreate and rerun a
    // possibly committed submission/post after a transport or tab failure.
    _canvasTabCheckedAt = 0;
    _helperLoaded = false;
    throw new Error(`Canvas browser operation failed; outcome may be unknown. No automatic replay. Inspect the target before retrying. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Ensure CanvasAPI is injected into Chrome, then run a JS expression that uses it */
function canvasExec(js: string): string {
  ensureCanvasTab();
  // First inject the helper if not present
  const injector = `(
    function() {
      if (window.__canvasAPI) return "already_loaded";
      function getCSRF() {
        var m = document.cookie.match(/_csrf_token=([^;]+)/);
        if (!m) throw new Error("No CSRF token - not logged into Canvas");
        return decodeURIComponent(m[1]);
      }
      function req(method, path, body) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, path, false);
        xhr.setRequestHeader("X-CSRF-Token", getCSRF());
        xhr.setRequestHeader("Accept", "application/json");
        if (body) {
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.send(JSON.stringify(body));
        } else xhr.send();
        if (xhr.status >= 400) throw new Error("API " + xhr.status + ": " + xhr.responseText.substring(0, 300));
        try { return JSON.parse(xhr.responseText); } catch (e) { return xhr.responseText; }
      }
      function getAll(path) {
        var results = []; var url = path;
        while (url) {
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, false);
          xhr.setRequestHeader("X-CSRF-Token", getCSRF());
          xhr.setRequestHeader("Accept", "application/json");
          xhr.send();
          if (xhr.status !== 200) break;
          var data = JSON.parse(xhr.responseText);
          results = results.concat(data);
          var link = xhr.getResponseHeader("Link");
          if (link) {
            var nm = link.match(/<([^>]+)>;\s*rel="next"/);
            url = nm ? nm[1] : null;
          } else url = null;
          if (data.length === 0) break;
        }
        return results;
      }
      window.__canvasAPI = {
        req: req, getAll: getAll,
        get: function(p) { return req("GET", p); },
        post: function(p, b) { return req("POST", p, b); },
        put: function(p, b) { return req("PUT", p, b); },
        del: function(p) { return req("DELETE", p); },
      };
      return "loaded";
    }
  )()`;
  // Skip the probe subprocess once we know the helper is injected in this tab.
  // _helperLoaded resets to false on stale-window recovery or a tab change.
  if (!_helperLoaded) {
    if (webRun('window.__canvasAPI ? "loaded" : "missing"') !== "loaded") {
      webRun(injector);
    }
    _helperLoaded = true;
  }
  // Wrap in try/catch so a thrown API call returns a JSON envelope instead of
  // osascript "missing value" (which made the web CLI retry 3x and leak stderr).
  return webRun(`(function(){ if (!window.__canvasAPI) return JSON.stringify({__ok:false,__helperMissing:true,err:"Canvas helper missing before dispatch"}); try { var v = ${js}; return JSON.stringify({__ok:true, v:v}); } catch(e){ return JSON.stringify({__ok:false, err:String((e&&e.message)||e)}); } })()`);
}

/** Run a canvas JS expression and parse the result as JSON. API errors thrown
 *  in the browser now surface as clean Error messages instead of "missing value". */
function canvasQuery(js: string): any {
  let raw = canvasExec(js);
  let parsed: any;
  const parse = (value: string) => {
    try { return JSON.parse(value); }
    catch { throw new Error(`Canvas API returned non-JSON response: ${value.substring(0, 200)}`); }
  };
  parsed = parse(raw);
  if (parsed && parsed.__ok === false && parsed.__helperMissing === true) {
    // Explicit pre-dispatch evidence only: the operation did not run because
    // the helper was missing. Generic JS/transport errors never trigger retries.
    _helperLoaded = false;
    raw = canvasExec(js);
    parsed = parse(raw);
  }
  if (parsed && parsed.__ok === false) throw new Error(`Canvas API error: ${parsed.err}`);
  return parsed ? parsed.v : undefined;
}

/** Clean outgoing Canvas text so Canvas does not show literal \\n or escaped quotes. */
function cleanOutgoingText(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\n/g, "\n")
    .trim();
  // Canvas stores rich-text entry bodies as HTML. Preserve caller-supplied HTML;
  // otherwise safely convert plain text/newlines instead of flattening paragraphs.
  if (/<[a-z][\s\S]*>/i.test(normalized)) return normalized.replace(/>\s+</g, "><");
  const escaped = normalized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped.replace(/\n/g, "<br>");
}

// --- Formatting helpers ---

/** Strip HTML tags and decode entities, like the browser view used in prior drafts. */
function stripHtml(html: string): string {
  return (html || "")
    .replace(/<br\s*\/?\>/gi, "\n")
    .replace(/<[^>]+\>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Preserve lecture paragraphs, resource URLs, embedded-video URLs and image labels. */
function formatPageBody(html: string): string {
  return stripHtml((html || "")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_all, attrs, label) => {
      const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
      return `${stripHtml(label)}${href ? ` (${href})` : ""}`;
    })
    .replace(/<(?:iframe|img)\b([^>]*)>/gi, (_all, attrs) => {
      const src = attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1];
      const alt = attrs.match(/\b(?:alt|title)\s*=\s*["']([^"']*)["']/i)?.[1];
      return `\n[${alt || "Embedded resource"}]${src ? ` (${src})` : ""}\n`;
    })
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n"));
}

/** Parse file-link anchors out of a Canvas discussion message HTML. */
function extractAttachmentLinks(messageHtml: string): Array<{ fileId: number; displayName: string }> {
  const out: Array<{ fileId: number; displayName: string }> = [];
  const re = /data-api-endpoint="[^"]*\/files\/(\d+)"[^>]*title="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(messageHtml || ""))) {
    out.push({ fileId: parseInt(m[1], 10), displayName: m[2] });
  }
  return out;
}

/** Resolve a Canvas file download URL (as the logged-in user) and extract its text. */
function getAttachmentText(scopeBase: string, fileId: number): { displayName: string; contentType: string; text: string; note: string } {
  const meta = canvasQuery(`window.__canvasAPI.get('${scopeBase}/files/${fileId}')`) as any;
  const url = meta.url as string;
  const contentType = (meta["content-type"] || meta.content_type || "") as string;
  const displayName = (meta.display_name || meta.filename || `file-${fileId}`) as string;
  if (!url) return { displayName, contentType, text: "", note: "No download URL found" };

  // Keep binary payloads out of CLI stdout until bounded chunks are requested.
  // Large lecture ZIPs otherwise overflow execFileSync and leak base64 in errors.
  const key = `__canvasDownload_${fileId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  try {
    const started = JSON.parse(webRun(`(function(){
      var xhr = new XMLHttpRequest();
      xhr.open("GET", ${JSON.stringify(url)}, false);
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
      try { xhr.send(); } catch(e) { return JSON.stringify({err:String(e)}); }
      if (xhr.status < 200 || xhr.status >= 300) return JSON.stringify({err:"HTTP "+xhr.status});
      var t = xhr.responseText || "";
      if (t.length > 64*1024*1024) return JSON.stringify({err:"Attachment exceeds 64 MiB download limit"});
      window[${JSON.stringify(key)}] = t;
      return JSON.stringify({length:t.length});
    })()`));
    if (started.err) return {displayName, contentType, text:"", note:`Download failed: ${started.err}`};
    if (!Number.isSafeInteger(started.length) || started.length <= 0) return {displayName, contentType, text:"", note:"Empty download"};
    for (let offset = 0; offset < started.length; offset += 1024*1024) {
      const chunk = JSON.parse(webRun(`(function(){
        var t = window[${JSON.stringify(key)}];
        if (typeof t !== "string") return JSON.stringify({err:"Download buffer lost; no automatic redownload"});
        var bin = ""; var end = Math.min(t.length, ${offset + 1024*1024});
        for (var i=${offset};i<end;i++) bin += String.fromCharCode(t.charCodeAt(i)&255);
        return JSON.stringify({b64:btoa(bin)});
      })()`));
      if (chunk.err || typeof chunk.b64 !== "string") throw new Error(chunk.err || "Invalid attachment chunk");
      chunks.push(Buffer.from(chunk.b64, "base64"));
    }
    if (chunks.reduce((n, b) => n+b.length, 0) !== started.length) throw new Error("Attachment download length mismatch");
  } finally {
    try { webRun(`(function(){delete window[${JSON.stringify(key)}];return "cleared";})()`); } catch {}
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const lower = displayName.toLowerCase();
  const ext = lower.endsWith(".pdf") ? ".pdf"
    : lower.endsWith(".docx") ? ".docx"
    : lower.endsWith(".doc") ? ".doc"
    : lower.endsWith(".zip") ? ".zip"
    : lower.endsWith(".ipynb") ? ".ipynb"
    : lower.endsWith(".html") ? ".html"
    : ".bin";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "littlecanvas-attachment-"));
  const tmp = path.join(tmpDir, `attachment${ext}`);
  fs.writeFileSync(tmp, Buffer.concat(chunks), { mode: 0o600 });

  let text = "";
  let note = "";
  try {
    if (ext === ".pdf") {
      text = execFileSync("pdftotext", ["-layout", tmp, "-"], { encoding: "utf-8", timeout: 20000, maxBuffer: 2*1024*1024 });
    } else if (ext === ".docx") {
      const py = `import docx; d=docx.Document(${JSON.stringify(tmp)}); print("\\n".join(p.text for p in d.paragraphs))`;
      text = execFileSync("python3", ["-c", py], { encoding: "utf-8", timeout: 20000, maxBuffer: 2*1024*1024 });
    } else if (ext === ".doc") {
      text = execFileSync("textutil", ["-convert", "txt", "-stdout", tmp], { encoding: "utf-8", timeout: 20000, maxBuffer: 2*1024*1024 });
    } else if ([".zip", ".ipynb", ".html"].includes(ext)) {
      text = execFileSync("python3", [join(__dirname, "extract-lecture.py"), tmp], {encoding:"utf-8", timeout:30000, maxBuffer:2*1024*1024});
    } else {
      note = "Unsupported file type; could not extract text";
    }
  } catch (e: any) {
    note = `Extraction failed: ${String(e.message).slice(0, 1000)}`;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  return { displayName, contentType, text: text.replace(/\u00a0/g, " ").trim(), note };
}


function formatCourse(c: any): string {
  return `${c.id}: ${c.name} (${c.course_code})`;
}

function formatAssignment(a: any): string {
  const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : "No due date";
  return `${a.id}: ${a.name} | ${a.points_possible}pts | Due: ${due}`;
}

function formatDiscussion(d: any): string {
  return `${d.id}: ${d.title}`;
}

function formatSubmission(s: any): string {
  const score = s.score !== null ? s.score : "—";
  const grade = s.grade !== null ? s.grade : "—";
  const submitted = s.submitted_at ? new Date(s.submitted_at).toLocaleDateString() : "Not submitted";
  return `Assignment ${s.assignment_id} | Score: ${score} | Grade: ${grade} | ${submitted}`;
}

// --- Tool parameters ---

const CanvasParams = Type.Object({
  action: StringEnum([
    "list_courses",
    "list_assignments",
    "list_discussions",
    "list_grades",
    "list_modules",
    "list_pages",
    "get_page",
    "list_files",
    "list_announcements",
    "list_groups",
    "whoami",
    "course_info",
    "submit_assignment",
    "post_discussion",
    "reply_discussion",
    "get_assignment",
    "get_discussion",
    "workshop_status",
    "get_attachment_text",
  ] as const, { description: "Canvas API action to perform" }),
  courseId: Type.Optional(Type.Number({ description: "Canvas course ID. Auto-detected from a suitable open Canvas tab when unambiguous; otherwise discover with list_courses." })),
  groupId: Type.Optional(Type.Number({ description: "Canvas group ID (from /groups/XXXXX). Use instead of courseId for group discussions; auto-detected from a suitable open Canvas tab when possible." })),
  assignmentId: Type.Optional(Type.Number({ description: "Canvas assignment ID. Auto-detected with courseId from a suitable open assignment tab when unambiguous." })),
  topicId: Type.Optional(Type.Number({ description: "Discussion topic ID" })),
  entryId: Type.Optional(Type.Number({ description: "Specific discussion entry ID to reply to (only for reply_discussion). Use get_discussion to find entry IDs." })),
  fileId: Type.Optional(Type.Number({ description: "Canvas file ID (for get_attachment_text). Use with courseId or groupId to resolve the scope." })),
  pageUrl: Type.Optional(Type.String({ description: "Canvas page slug from list_pages, required for get_page. Returns lecture text and linked resources." })),
  fullText: Type.Optional(Type.Boolean({ description: "For get_discussion: full messages and attachments. For get_attachment_text: extracted text up to 40000 characters instead of the 1500-character preview. Defaults to false." })),
  text: Type.Optional(Type.String({ description: "Text body for submission or discussion post (supports HTML)" })),
});

type CanvasAction = "list_courses" | "list_assignments" | "list_discussions" | "list_grades" | "list_modules" | "list_pages" | "get_page" | "list_files" | "list_announcements" | "list_groups" | "whoami" | "course_info" | "submit_assignment" | "post_discussion" | "reply_discussion" | "get_assignment" | "get_discussion" | "workshop_status" | "get_attachment_text";

/** Resolve the scope prefix for API calls. Group discussions use /groups/{groupId}/ instead of /courses/{courseId}/. */
function scopePrefix(params: { courseId?: number; groupId?: number }): string {
  if (params.groupId) return `/api/v1/groups/${params.groupId}`;
  if (params.courseId) return `/api/v1/courses/${params.courseId}`;
  throw new Error("courseId or groupId required for this action");
}

interface CanvasDetails {
  action: CanvasAction;
  error?: string;
  [key: string]: any;
}

type DetectedCanvasContext = {
  courseId?: number;
  assignmentId?: number;
  groupId?: number;
  url?: string;
  source?: "active-user-tab" | "bot-session-tab" | "single-open-assignment";
};

/** Detect IDs without taking control of any tab. Prefer the user's active Canvas
 * tab, then the bot session tab, then a single unambiguous assignment URL. */
function detectCanvasContextFromTabs(): DetectedCanvasContext {
  const raw = webCmd(["tabs"], 10_000);
  if (!raw) return {};
  const rows = raw.split(/\r?\n/).slice(1).map((line) => {
    const columns = line.split("\t");
    return { url: columns[4] || "", markers: columns.slice(5).join(",") };
  }).filter((row) => isCanvasUrl(row.url));

  const parse = (url: string, source: DetectedCanvasContext["source"]): DetectedCanvasContext => {
    const course = url.match(/\/courses\/(\d+)/)?.[1];
    const assignment = url.match(/\/assignments\/(\d+)/)?.[1];
    const group = url.match(/\/groups\/(\d+)/)?.[1];
    return {
      courseId: course ? Number(course) : undefined,
      assignmentId: assignment ? Number(assignment) : undefined,
      groupId: group ? Number(group) : undefined,
      url,
      source,
    };
  };

  const activeUser = rows.find((row) => /(^|,)active(,|$)/.test(row.markers) && !row.markers.includes("bot-window"));
  if (activeUser) return parse(activeUser.url, "active-user-tab");
  const botSession = rows.find((row) => row.markers.includes("bot-session"));
  if (botSession && /\/(courses|groups)\//.test(botSession.url)) return parse(botSession.url, "bot-session-tab");

  const uniqueAssignments = new Map<string, string>();
  for (const row of rows) {
    const match = row.url.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
    if (match) uniqueAssignments.set(`${match[1]}:${match[2]}`, row.url);
  }
  if (uniqueAssignments.size === 1) return parse([...uniqueAssignments.values()][0], "single-open-assignment");
  return {};
}

export default function (pi: ExtensionAPI) {
  function detectCourseFromChrome(): number | null {
    return detectCanvasContextFromTabs().courseId ?? null;
  }

  function detectGroupFromChrome(): number | null {
    return detectCanvasContextFromTabs().groupId ?? null;
  }

  pi.registerTool({
    name: "canvas",
    label: "Canvas LMS",
    description:
      "Control Canvas LMS through its authenticated browser API without taking over the user's active Chrome tab. " +
      "The extension owns a pinned background Canvas API tab inside the named Pi Automation window, while MyOpenMath and the user may continue in other tabs. " +
      "Actions: list_courses, course_info, list_assignments, list_discussions, list_grades, list_modules, list_pages, get_page, list_files, list_announcements, list_groups, whoami, submit_assignment, post_discussion, reply_discussion, get_assignment, get_discussion, workshop_status, get_attachment_text. " +
      "Course, assignment, and group IDs are auto-detected from suitable open Canvas tabs when unambiguous.",
    promptSnippet: "Manage Canvas courses, assignments, discussions, and grades",
    promptGuidelines: [
      `Use canvas to interact with the user's configured Canvas LMS (${CANVAS_ORIGIN}) instead of manual browser clicks.`,
      "Write actions require explicit user intent. Never automatically replay a submission/post/reply after an uncertain browser response; inspect the actual outcome first.",
      "Canvas owns a pinned background API tab in the Pi Automation window. Do not open a new Pi session, switch the user's active Chrome tab, or manually set up Canvas with web_cli; the tool handles its own authenticated tab.",
      "Course/assignment/group IDs are auto-detected from a suitable active or uniquely identifiable open Canvas tab. If they remain unknown, use canvas list_courses and then list_assignments instead of opening browser sessions or guessing IDs.",
      "For lecture/course-page reading, use list_pages then get_page with the returned pageUrl slug. Follow linked Canvas files using get_attachment_text with fullText=true when needed.",
      "For submit_assignment, provide text as HTML or plain text in the text parameter. The tool preserves HTML and converts plain-text newlines safely for Canvas rich-text submission.",
      "post_discussion creates a NEW top-level entry in a discussion topic - use this when the user says 'reply to discussion' or 'post in discussion'. Only needs courseId, topicId, and text.",
      "reply_discussion replies to a SPECIFIC existing entry within a topic - it requires entryId (get it from get_discussion first). Only use reply_discussion when the user explicitly wants to respond to a particular person's post.",
      "When a user says 'reply to the discussion' without specifying a person, use post_discussion (NOT reply_discussion). reply_discussion requires an entryId that you must look up first.",
      "courseId can often be found in the Canvas URL pattern: /courses/XXXXX",
      "IMPORTANT: When the discussion URL contains /groups/XXXXX instead of /courses/XXXXX, it is a GROUP discussion. Use the groupId parameter instead of courseId. The tool will route API calls to /api/v1/groups/{groupId}/ instead of /api/v1/courses/{courseId}/. This is required for workshop groups and similar Canvas group features.",
      "WORKSHOP PEER REPLIES streamlined flow: (1) list_groups to find the P1/P2 workshop group, (2) list_discussions with that groupId to find the workshop topic, (3) workshop_status with groupId+topicId returns the current user plus every peer draft (full text + extracted attachment text) and flags which peers still NEEDS REPLY, (4) reply_discussion to each NEEDS REPLY entryId. workshop_status gets everything needed to write the replies in one call.",
    ],
    parameters: CanvasParams,

    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const out: any = { ...(args as any) };
      const aliases: Record<string, string> = {
        course_id: "courseId", assignment_id: "assignmentId", group_id: "groupId",
        topic_id: "topicId", entry_id: "entryId", file_id: "fileId",
      };
      for (const [legacy, current] of Object.entries(aliases)) {
        if (out[current] === undefined && out[legacy] !== undefined) out[current] = out[legacy];
        delete out[legacy];
      }
      for (const key of ["courseId", "assignmentId", "groupId", "topicId", "entryId", "fileId"]) {
        if (typeof out[key] === "string" && /^\d+$/.test(out[key])) out[key] = Number(out[key]);
      }
      return out;
    },

    async execute(_toolCallId, incomingParams, _signal, _onUpdate, _ctx) {
      const contextFree = ["list_courses", "list_groups", "whoami"].includes(incomingParams.action);
      const assignmentAction = ["get_assignment", "submit_assignment"].includes(incomingParams.action);
      const needsDetectedScope = !contextFree && incomingParams.courseId === undefined && incomingParams.groupId === undefined;
      const needsDetectedAssignment = assignmentAction && incomingParams.assignmentId === undefined;
      const detected = (needsDetectedScope || needsDetectedAssignment) ? detectCanvasContextFromTabs() : {};
      const params = {
        ...incomingParams,
        courseId: incomingParams.courseId ?? detected.courseId,
        assignmentId: incomingParams.assignmentId ?? detected.assignmentId,
        groupId: incomingParams.groupId ?? detected.groupId,
      };
      const courseId = params.courseId;
      const groupId = params.groupId;

      try {
        switch (params.action) {
          // --- Read-only list actions ---

          case "list_courses": {
            const courses = canvasQuery("window.__canvasAPI.getAll('/api/v1/courses?per_page=100&include[]=term').map(function(c){return {id:c.id,name:c.name,course_code:c.course_code,workflow_state:c.workflow_state}})");
            const active = (courses as any[]).filter(
              (c: any) => c.name && c.workflow_state === "available"
            );
            const lines = active.map(formatCourse);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Your Canvas Courses (${active.length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, courses: active } as CanvasDetails,
            };
          }

          case "course_info": {
            if (!courseId) throw new Error("courseId required for course_info");
            const course = canvasQuery(`window.__canvasAPI.get('/api/v1/courses/${courseId}')`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Course: ${course.name}\nCode: ${course.course_code}\nID: ${course.id}\nStart: ${course.start_at || "N/A"}\nEnd: ${course.end_at || "N/A"}`,
                },
              ],
              details: { action: params.action, course } as CanvasDetails,
            };
          }

          case "list_assignments": {
            if (!courseId) throw new Error("courseId required for list_assignments");
            const assignments = canvasQuery(
              `window.__canvasAPI.getAll('/api/v1/courses/${courseId}/assignments?per_page=100').map(function(a){return {id:a.id,name:a.name,points_possible:a.points_possible,due_at:a.due_at,submission_types:a.submission_types}})`
            );
            const lines = (assignments as any[]).map(formatAssignment);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Assignments (${(assignments as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, assignments } as CanvasDetails,
            };
          }

          case "list_discussions": {
            if (!courseId && !groupId) throw new Error("courseId (or groupId) required for list_discussions");
            const discScope = scopePrefix(params);
            const discussions = canvasQuery(
              `window.__canvasAPI.getAll('${discScope}/discussion_topics?per_page=100').map(function(d){return {id:d.id,title:d.title,discussion_subentry_count:d.discussion_subentry_count,assignment_id:d.assignment_id}})`
            );
            const scopeLabel = groupId ? ` (group ${groupId})` : "";
            const lines = (discussions as any[]).map(function (d: any) {
              return `${d.id}: ${d.title}${scopeLabel}`;
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Discussions (${(discussions as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, discussions } as CanvasDetails,
            };
          }

          case "list_grades": {
            if (!courseId) throw new Error("courseId required for list_grades");
            const me = canvasQuery("window.__canvasAPI.get('/api/v1/users/self')");
            const subs = canvasQuery(
              `window.__canvasAPI.get('/api/v1/courses/${courseId}/students/submissions?per_page=100&student_id=${me.id}').map(function(s){return {assignment_id:s.assignment_id,score:s.score,grade:s.grade,submitted_at:s.submitted_at,workflow_state:s.workflow_state}})`
            );
            const lines = (subs as any[]).map(formatSubmission);
            // Also get enrollment for overall grade
            const enrollments = canvasQuery(
              `window.__canvasAPI.get('/api/v1/courses/${courseId}/enrollments?per_page=100&user_id=${me.id}&include[]=grades')`
            );
            const enrollment = (enrollments as any[]).find(
              (e: any) => e.type === "StudentEnrollment"
            );
            const overallGrade = enrollment?.grades?.current_score ?? "N/A";
            const overallLetter = enrollment?.grades?.current_grade ?? "N/A";
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Grades for ${me.name} | Overall: ${overallLetter} (${overallGrade}%)\n` +
                    `Submissions:\n${lines.join("\n")}`,
                },
              ],
              details: {
                action: params.action,
                submissions: subs,
                overallScore: overallGrade,
                overallLetter,
              } as CanvasDetails,
            };
          }

          case "list_modules": {
            if (!courseId) throw new Error("courseId required for list_modules");
            const modules = canvasQuery(
              `window.__canvasAPI.getAll('/api/v1/courses/${courseId}/modules?per_page=100').map(function(m){return {id:m.id,name:m.name,items_count:m.items_count}})`
            );
            const lines = (modules as any[]).map(
              (m: any) => `${m.id}: ${m.name} (${m.items_count} items)`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Modules (${(modules as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, modules } as CanvasDetails,
            };
          }

          case "list_pages": {
            if (!courseId) throw new Error("courseId required for list_pages");
            const pages = canvasQuery(
              `window.__canvasAPI.getAll('/api/v1/courses/${courseId}/pages?per_page=100').map(function(p){return {url:p.url,title:p.title}})`
            );
            const lines = (pages as any[]).map(
              (p: any) => `${p.url}: ${p.title}`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Pages (${(pages as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, pages } as CanvasDetails,
            };
          }

          case "list_files": {
            if (!courseId) throw new Error("courseId required for list_files");
            const files = canvasQuery(
              `window.__canvasAPI.getAll('/api/v1/courses/${courseId}/files?per_page=100').map(function(f){return {id:f.id,filename:f.filename,size:f.size,url:f.url}})`
            );
            const lines = (files as any[]).map(
              (f: any) => `${f.id}: ${f.filename} (${f.size} bytes) ${f.url}`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Files (${(files as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, files } as CanvasDetails,
            };
          }

          case "list_announcements": {
            if (!courseId) throw new Error("courseId required for list_announcements");
            const announcements = canvasQuery(
              `window.__canvasAPI.getAll('/api/v1/courses/${courseId}/announcements?per_page=100').map(function(a){return {id:a.id,title:a.title,posted_at:a.posted_at}})`
            );
            const lines = (announcements as any[]).map(
              (a: any) => `${a.id}: ${a.title} (${new Date(a.posted_at).toLocaleDateString()})`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Announcements (${(announcements as any[]).length}):\n${lines.join("\n")}`,
                },
              ],
              details: { action: params.action, announcements } as CanvasDetails,
            };
          }

          // --- Detail views ---

          case "get_page": {
            if (!courseId || !params.pageUrl) throw new Error("courseId and pageUrl required for get_page; use list_pages for page slugs");
            const path = `/api/v1/courses/${courseId}/pages/${encodeURIComponent(params.pageUrl)}`;
            const page = canvasQuery(`window.__canvasAPI.get(${JSON.stringify(path)})`) as any;
            const body = formatPageBody(page.body || "");
            const limit = 40000;
            return {
              content: [{ type: "text" as const, text:
                `${page.title}\nURL: ${page.html_url || ""}\nUpdated: ${page.updated_at || "unknown"}\n---\n` +
                body.substring(0, limit) + (body.length > limit ? `\n[Truncated: ${body.length} characters total]` : "") }],
              details: { action: params.action, page: { ...page, text: body } } as CanvasDetails,
            };
          }

          case "get_assignment": {
            if (!courseId || !params.assignmentId)
              throw new Error("courseId and assignmentId required for get_assignment");
            const assignment = canvasQuery(
              `window.__canvasAPI.get('/api/v1/courses/${courseId}/assignments/${params.assignmentId}')`
            );
            const a = assignment as any;
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${a.name}\n` +
                    `ID: ${a.id} | Points: ${a.points_possible}\n` +
                    `Due: ${a.due_at ? new Date(a.due_at).toLocaleString() : "No due date"}\n` +
                    `Type: ${a.submission_types?.join(", ") || "N/A"}\n` +
                    `Description: ${(a.description || "").substring(0, 500)}`,
                },
              ],
              details: { action: params.action, assignment: { ...a, description: (a.description || "").substring(0, 500) } } as CanvasDetails,
            };
          }

          case "get_discussion": {
            if ((!courseId && !groupId) || !params.topicId)
              throw new Error("courseId (or groupId) and topicId required for get_discussion");
            const discScope = scopePrefix(params);
            const topic = canvasQuery(
              `window.__canvasAPI.get('${discScope}/discussion_topics/${params.topicId}')`
            );
            const t = topic as any;
            const wantFull = params.fullText === true;
            const entries = canvasQuery(
              `window.__canvasAPI.get('${discScope}/discussion_topics/${params.topicId}/entries?per_page=100').map(function(e){return {id:e.id,user_id:e.user_id,user_name:e.user_name,created_at:e.created_at,message:e.message||""}}).slice(0,60)`
            );
            const entryList = entries as any[];
            const withReplies = entryList.map(function (e: any) {
              let replyAuthors: string[] = [];
              try {
                replyAuthors = canvasQuery(
                  `window.__canvasAPI.get('${discScope}/discussion_topics/${params.topicId}/entries/${e.id}/replies?per_page=100').map(function(r){return r.user_name||""})`
                ) as any[];
              } catch { replyAuthors = []; }
              return { ...e, replyAuthors };
            });

            const entryLines = withReplies.map(function (e: any) {
              const body = wantFull ? stripHtml(e.message) : stripHtml(e.message).substring(0, 120);
              const attachments = wantFull ? extractAttachmentLinks(e.message) : [];
              const attInfo = wantFull && attachments.length
                ? " | attachments: " + attachments.map(function (a: any) { return a.fileId + ":" + a.displayName; }).join(", ")
                : "";
              const reps = e.replyAuthors.length ? " | replied by: " + e.replyAuthors.join(", ") : "";
              return `  [${e.id}] ${e.user_name}${reps}${attInfo}\n    ${body}`;
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${t.title}\n` +
                    `ID: ${t.id} | Replies: ${t.discussion_subentry_count || 0}\n` +
                    `Entries:\n${entryLines.join("\n")}`,
                },
              ],
              details: {
                action: params.action,
                topic: { id: t.id, title: t.title, discussion_subentry_count: t.discussion_subentry_count },
                entries: withReplies.map(function (e: any) {
                  return {
                    id: e.id, user_id: e.user_id, user_name: e.user_name,
                    message: wantFull ? stripHtml(e.message) : stripHtml(e.message).substring(0, 160),
                    attachments: wantFull ? extractAttachmentLinks(e.message) : [],
                    replyAuthors: e.replyAuthors,
                  };
                }),
              } as CanvasDetails,
            };
          }

          // --- Write actions ---

          case "submit_assignment": {
            if (!courseId || !params.assignmentId || !params.text)
              throw new Error("submit_assignment needs courseId and assignmentId. Keep the intended Canvas assignment open, or call list_courses then list_assignments; do not open a new Pi/browser session.");
            const assignment = canvasQuery(
              `window.__canvasAPI.get('/api/v1/courses/${courseId}/assignments/${params.assignmentId}')`
            ) as any;
            if (!Array.isArray(assignment.submission_types) || !assignment.submission_types.includes("online_text_entry")) {
              throw new Error(`Assignment ${params.assignmentId} does not accept online_text_entry (accepted: ${(assignment.submission_types || []).join(", ") || "unknown"}).`);
            }
            const cleanText = cleanOutgoingText(params.text);
            const result = canvasQuery(
              `window.__canvasAPI.post('/api/v1/courses/${courseId}/assignments/${params.assignmentId}/submissions', {submission:{submission_type:"online_text_entry",body:${JSON.stringify(cleanText)}}})`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✓ Submitted assignment ${params.assignmentId} in course ${courseId}`,
                },
              ],
              details: { action: params.action, result } as CanvasDetails,
            };
          }

          case "post_discussion": {
            if ((!courseId && !groupId) || !params.topicId || !params.text)
              throw new Error("courseId (or groupId), topicId, and text required for post_discussion");
            const discScope = scopePrefix(params);
            const cleanText = cleanOutgoingText(params.text);
            const result = canvasQuery(
              `window.__canvasAPI.post('${discScope}/discussion_topics/${params.topicId}/entries', {message:${JSON.stringify(cleanText)}})`
            );
            const scopeLabel = groupId ? `group ${groupId}` : `course ${courseId}`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✓ Posted to discussion ${params.topicId} in ${scopeLabel}`,
                },
              ],
              details: { action: params.action, result } as CanvasDetails,
            };
          }

          case "reply_discussion": {
            if ((!courseId && !groupId) || !params.topicId || !params.entryId || !params.text)
              throw new Error(
                "reply_discussion requires courseId (or groupId), topicId, entryId, and text. " +
                "Did you mean post_discussion? Use post_discussion to create a new entry in a discussion topic (no entryId needed). " +
                "Use get_discussion first to find the entryId if you need to reply to a specific person's post."
              );
            const discScope = scopePrefix(params);
            const cleanText = cleanOutgoingText(params.text);
            const result = canvasQuery(
              `window.__canvasAPI.post('${discScope}/discussion_topics/${params.topicId}/entries/${params.entryId}/replies', {message:${JSON.stringify(cleanText)}})`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✓ Replied to entry ${params.entryId} in discussion ${params.topicId}`,
                },
              ],
              details: { action: params.action, result } as CanvasDetails,
            };
          }

          case "whoami": {
            const me = canvasQuery("window.__canvasAPI.get('/api/v1/users/self')");
            return {
              content: [
                { type: "text" as const, text: `Logged in as: ${me.name} (id: ${me.id})` },
              ],
              details: { action: params.action, user: { id: me.id, name: me.name, sortable_name: me.sortable_name } } as CanvasDetails,
            };
          }

          case "list_groups": {
            const groups = canvasQuery(
              "window.__canvasAPI.getAll('/api/v1/users/self/groups?per_page=100').map(function(g){return {id:g.id,name:g.name,context_type:g.context_type,course_id:g.course_id}})"
            );
            const lines = (groups as any[]).map(function (g: any) {
              return `${g.id}: ${g.name} (${g.context_type || ""}${g.course_id ? " course:" + g.course_id : ""})`;
            });
            return {
              content: [
                { type: "text" as const, text: `Groups (${(groups as any[]).length}):\n${lines.join("\n")}` },
              ],
              details: { action: params.action, groups } as CanvasDetails,
            };
          }

          case "get_attachment_text": {
            if (!params.fileId) throw new Error("fileId required for get_attachment_text");
            const scopeBase = scopePrefix(params);
            const att = getAttachmentText(scopeBase, params.fileId);
            const limit = params.fullText === true ? 40000 : 1500;
            const preview = att.text ? att.text.substring(0, limit) : "(no text extracted)";
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Attachment: ${att.displayName}\n` +
                    `Content-Type: ${att.contentType || "unknown"}\n` +
                    (att.note ? `Note: ${att.note}\n` : "") +
                    `---\n${preview}${att.text && att.text.length > limit ? `\n[Truncated: ${att.text.length} characters total; use fullText=true for a longer read]` : ""}`,
                },
              ],
              details: { action: params.action, fileId: params.fileId, displayName: att.displayName, contentType: att.contentType, text: att.text, note: att.note } as CanvasDetails,
            };
          }

          case "workshop_status": {
            if (!groupId || !params.topicId)
              throw new Error("groupId and topicId required for workshop_status");
            const wsScope = scopePrefix(params);
            const me = canvasQuery("window.__canvasAPI.get('/api/v1/users/self')") as any;
            const topic = canvasQuery(`window.__canvasAPI.get('${wsScope}/discussion_topics/${params.topicId}')`) as any;
            const entries = canvasQuery(
              `window.__canvasAPI.get('${wsScope}/discussion_topics/${params.topicId}/entries?per_page=100').map(function(e){return {id:e.id,user_id:e.user_id,user_name:e.user_name,created_at:e.created_at,message:e.message||""}})`
            ) as any[];

            const peers: any[] = [];
            for (const e of entries) {
              const isMe = e.user_id === me.id || (e.user_name || "").toLowerCase() === (me.name || "").toLowerCase();
              let replyAuthors: string[] = [];
              try {
                replyAuthors = canvasQuery(
                  `window.__canvasAPI.get('${wsScope}/discussion_topics/${params.topicId}/entries/${e.id}/replies?per_page=100').map(function(r){return r.user_name||""})`
                ) as any[];
              } catch { replyAuthors = []; }
              const myNameLast = (me.name || "").split(",").pop().trim().toLowerCase();
              const iReplied = replyAuthors.some(function (n: string) {
                const nl = (n || "").toLowerCase();
                return nl === (me.name || "").toLowerCase() || nl === (me.sortable_name || "").toLowerCase() || nl.includes(myNameLast);
              });

              let draftText = stripHtml(e.message);
              const links = extractAttachmentLinks(e.message);
              const attachments: any[] = [];
              for (const link of links) {
                const att = getAttachmentText(wsScope, link.fileId);
                attachments.push({ fileId: link.fileId, displayName: att.displayName, text: att.text, note: att.note });
                if (att.text) draftText += "\n\n[ATTACHMENT: " + att.displayName + "]\n" + att.text;
              }

              peers.push({
                entryId: e.id,
                userId: e.user_id,
                userName: e.user_name,
                isMe,
                needsReply: !isMe && !iReplied,
                alreadyReplied: iReplied,
                draftText,
                attachments: attachments.map(function (a: any) { return { fileId: a.fileId, displayName: a.displayName, note: a.note }; }),
              });
            }

            const needReply = peers.filter(function (p: any) { return p.needsReply; });
            const lines = peers.map(function (p: any) {
              const status = p.isMe ? "ME (skip)" : p.alreadyReplied ? "already replied" : "NEEDS REPLY";
              const head = `  [${p.entryId}] ${p.userName} - ${status}`;
              const preview = p.draftText ? p.draftText.replace(/\n/g, " ").substring(0, 100) : "(attached draft)";
              return head + " | " + preview;
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Workshop: ${topic.title}\n` +
                    `You: ${me.name} (id: ${me.id})\n` +
                    `Peers needing a reply: ${needReply.length}\n\n` +
                    lines.join("\n") +
                    (needReply.length ? "\n\nUse reply_discussion with each NEEDS REPLY entryId." : "\n\nAll peer replies are done."),
                },
              ],
              details: {
                action: params.action,
                groupId, topicId: params.topicId,
                me: { id: me.id, name: me.name, sortable_name: me.sortable_name },
                topic: { id: topic.id, title: topic.title },
                peers,
              } as CanvasDetails,
            };
          }

          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message}`,
            },
          ],
          details: { action: params.action, error: err.message } as CanvasDetails,
          isError: true,
        };
      }
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("canvas ")) + theme.fg("muted", args.action);
      if (args.courseId) text += ` ${theme.fg("accent", `course:${args.courseId}`)}`;
      if (args.assignmentId)
        text += ` ${theme.fg("dim", `assign:${args.assignmentId}`)}`;
      if (args.topicId) text += ` ${theme.fg("dim", `topic:${args.topicId}`)}`;
      if (args.entryId) text += ` ${theme.fg("dim", `entry:${args.entryId}`)}`;
      if (args.text) text += ` ${theme.fg("dim", `"${args.text.substring(0, 40)}..."`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as CanvasDetails | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      const textContent = result.content[0];
      const msg = textContent?.type === "text" ? textContent.text : "";

      if (msg.startsWith("✓")) {
        return new Text(theme.fg("success", msg), 0, 0);
      }

      if (!expanded) {
        // Compact: first 3 lines
        const lines = msg.split("\n");
        const compact = lines.slice(0, 3).join("\n");
        const suffix = lines.length > 3 ? theme.fg("dim", `\n... ${lines.length - 3} more lines`) : "";
        return new Text(compact + suffix, 0, 0);
      }

      return new Text(msg, 0, 0);
    },
  });

  // /canvas command for quick info
  pi.registerCommand("canvas", {
    description: "Show Canvas course info from current Chrome tab",
    handler: async (_args, ctx) => {
      const courseId = detectCourseFromChrome();
      if (!courseId) {
        ctx.ui.notify("No Canvas course detected in current Chrome tab", "warning");
        return;
      }

      try {
        const course = canvasQuery(`window.__canvasAPI.get('/api/v1/courses/${courseId}')`);
        ctx.ui.notify(`Canvas: ${course.name} (${course.course_code})`, "info");
      } catch {
        ctx.ui.notify("Failed to fetch Canvas info - is Chrome logged in?", "error");
      }
    },
  });
}