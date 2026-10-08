#!/usr/bin/env node
// Metadata/prerequisite checks only: never opens Chrome or calls Canvas.
import { existsSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const checks = [];
function check(name, required, fn) {
  try { checks.push({ name, required, ok: true, detail: String(fn()) }); }
  catch { checks.push({ name, required, ok: false, detail: 'Missing or unavailable; see README setup requirements.' }); }
}
function executable(name) {
  const paths = name.includes('/') ? [name] : (process.env.PATH || '').split(':').map(p => join(p, name));
  const found = paths.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  if (!found) throw Error('not found');
  return found;
}
check('macOS', true, () => { if (process.platform !== 'darwin') throw Error(); return process.platform; });
check('Node >=22.19', true, () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw Error();
  return process.versions.node;
});
check('Pi', true, () => execFileSync(executable('pi'), ['--version'], { encoding: 'utf8', timeout: 10000 }).trim());
check('Canvas origin setting', true, () => {
  const url = new URL(process.env.CANVAS_BASE_URL || 'https://ucdenver.instructure.com');
  if (url.protocol !== 'https:' || url.username || url.password) throw Error();
  return 'Valid HTTPS origin; connection/login not exercised.';
});
check('LittleCua web shim', true, () => executable(process.env.WEB_CLI_PATH || (existsSync(join(homedir(), '.local/bin/web')) ? join(homedir(), '.local/bin/web') : 'web')));
check('CuaDriver', true, () => executable(process.env.CUA_DRIVER_BIN || (existsSync('/Applications/CuaDriver.app/Contents/MacOS/cua-driver') ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver')));
check('Chrome', true, () => { if (!existsSync('/Applications/Google Chrome.app')) throw Error(); return 'Installed; sign in and approve Apple Events yourself.'; });
check('AppleScript', true, () => executable('/usr/bin/osascript'));
check('Python 3 (lecture archives/notebooks/HTML)', false, () => executable('python3'));
check('pdftotext / Poppler (PDF attachments)', false, () => executable('pdftotext'));
check('python-docx (DOCX attachments)', false, () => execFileSync(executable('python3'), ['-c', 'import docx; print(docx.__version__)'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore','pipe','pipe'] }).trim());
check('textutil (legacy DOC attachments)', false, () => executable('/usr/bin/textutil'));
for (const c of checks) console.log(`${c.ok ? 'OK' : c.required ? 'MISSING' : 'OPTIONAL MISSING'} ${c.name}: ${c.detail}`);
console.log('Read-only prerequisite check only; no Canvas requests, browser actions, writes, permissions or session success were tested.');
process.exitCode = checks.some(c => c.required && !c.ok) ? 1 : 0;
