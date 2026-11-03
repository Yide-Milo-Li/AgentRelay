// Verify persistence and OS overrides in a real browser against a built local Worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5190";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Theme checks require a local Worker.");
const run = crypto.randomUUID();
const session = `agentrelay-theme-${run.slice(0, 8)}`;
const headers = identityHeaders(`theme-qa-${run}`, "theme@sites.test");
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const output = path.resolve(process.env.AGENTRELAY_QA_OUTPUT ?? `outputs/theme/${run}`);
const checks = [];
await mkdir(output, { recursive: true });

async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    // Windows daemons can inherit the CLI pipes, so completion follows exit rather than pipe closure.
    child.on("exit", code => {
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve(text); else reject(new Error(error || text || `agent-browser exited ${code}`));
    });
  });
  const result = JSON.parse(stdout.trim());
  if (!result.success) throw new Error(result.error);
  return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const wait = expression => browser("wait", "--fn", expression);
const preference = () => evaluate("document.querySelector('.theme-setting').dataset.themePreference");
async function choose(target) {
  await browser("click", `.theme-option[data-theme-value="${target}"]`);
  assert.equal(await preference(), target, `selecting ${target} applies it`);
}
// Appearance lives in Settings, which every page of this run stays on.
const openSettings = () => browser("click", ".settings-button");
const resolved = preference => wait(`document.querySelector('.theme-option:not(:disabled)') && document.documentElement.dataset.theme === '${preference}' && getComputedStyle(document.documentElement).colorScheme === '${preference}'`);
async function check(name, expression) {
  assert.equal(await evaluate(expression), true, name);
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await browser("set", "media", "dark");
  await browser("--headers", JSON.stringify(headers), "open", base);
  await openSettings();
  await wait("document.querySelector('.theme-option:not(:disabled)') !== null");
  await resolved("dark");
  await check("first visit follows a dark OS without saving an override", "localStorage.getItem('agentrelay-theme') === null && document.querySelector('.theme-setting').dataset.themePreference === 'system'");
  await browser("set", "media", "light");
  await resolved("light");
  await check("system mode follows OS changes while open", "document.querySelector('.theme-setting').dataset.themePreference === 'system'");
  await browser("reload");
  await openSettings();
  await resolved("light");
  await check("a fresh light OS still uses system mode", "localStorage.getItem('agentrelay-theme') === null && document.querySelector('.theme-setting').dataset.themePreference === 'system'");

  for (const mode of ["light", "dark", "system"]) {
    await browser("click", `.theme-option[data-theme-value="${mode}"]`);
    await check(`choosing ${mode} marks only that option pressed`, `document.querySelector('.theme-setting').dataset.themePreference === '${mode}' && [...document.querySelectorAll('.theme-option')].every(option => (option.getAttribute('aria-pressed') === 'true') === (option.dataset.themeValue === '${mode}'))`);
  }

  await choose("dark");
  await resolved("dark");
  await check("manual dark overrides a light OS and saves the preference", "localStorage.getItem('agentrelay-theme') === 'dark'");
  await browser("reload");
  await openSettings();
  await resolved("dark");
  await check("reload restores manual dark", "document.querySelector('.theme-setting').dataset.themePreference === 'dark'");
  await browser("set", "media", "dark");
  await choose("light");
  await resolved("light");
  await browser("set", "media", "light");
  await browser("set", "media", "dark");
  await resolved("light");
  await check("manual light survives subsequent OS changes", "localStorage.getItem('agentrelay-theme') === 'light'");
  await browser("reload");
  await openSettings();
  await resolved("light");
  await check("reload restores manual light against a dark OS", "document.querySelector('.theme-setting').dataset.themePreference === 'light'");

  await browser("tab", "new", "--label", "mirror", base);
  await openSettings();
  await resolved("light");
  await choose("dark");
  await browser("tab", "t1");
  await resolved("dark");
  await check("another tab synchronizes the saved preference", "document.querySelector('.theme-setting').dataset.themePreference === 'dark'");
  await choose("system");
  await resolved("dark");
  await browser("set", "media", "light");
  await resolved("light");
  await browser("reload");
  await openSettings();
  await resolved("light");
  await check("returning to system persists and resumes OS tracking", "localStorage.getItem('agentrelay-theme') === 'system' && document.querySelector('.theme-setting').dataset.themePreference === 'system'");

  await browser("focus", '.theme-option[data-theme-value="light"]');
  await browser("press", "Enter");
  await resolved("light");
  await check("Enter selects the focused option and keeps keyboard focus", "document.activeElement.matches('.theme-option[data-theme-value=\"light\"]') && document.querySelector('.theme-setting').dataset.themePreference === 'light' && !document.querySelector('dialog[open]')");
  await browser("focus", '.theme-option[data-theme-value="dark"]');
  await browser("press", "Space");
  await resolved("dark");
  await check("Space selects the focused option with a visible focus outline", "document.activeElement.matches('.theme-option[data-theme-value=\"dark\"]') && document.querySelector('.theme-setting').dataset.themePreference === 'dark' && getComputedStyle(document.activeElement).outlineStyle !== 'none'");

  for (const lang of ["en", "zh"]) {
    await browser("click", `.lang-switch button[lang='${lang === "zh" ? "zh-CN" : "en"}']`);
    await check(`${lang} appearance group is labelled and every option is named`, `document.querySelector('.theme-setting').getAttribute('aria-label') === '${lang === "zh" ? "主题" : "Appearance"}' && [...document.querySelectorAll('.theme-option')].every(option => option.textContent.trim().length > 0)`);
    for (const theme of ["light", "dark"]) {
      await choose(theme);
      await resolved(theme);
      for (const width of [1440, 1024, 720, 430, 390, 360, 320]) {
        await browser("set", "viewport", String(width), "900");
        await check(`${lang} ${theme} header fits at ${width}px`, `(() => {
          const boxes = [...document.querySelectorAll('.brand, .tabs, .device-pick, .settings-button, .top-tools > .new')].map(el => el.getBoundingClientRect());
          return document.documentElement.scrollWidth <= innerWidth && boxes.every(box => box.left >= 0 && box.right <= innerWidth + 1) && boxes.every((a, i) => boxes.slice(i + 1).every(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1));
        })()`);
        if ([1440, 390].includes(width)) await browser("screenshot", path.join(output, `${lang}-${theme}-${width}.png`));
      }
    }
  }
  const errors = await browser("errors");
  assert.deepEqual(errors.errors ?? [], [], "no uncaught browser or hydration errors");
  checks.push("no uncaught browser or hydration errors");
  await writeFile(path.join(output, "result.json"), JSON.stringify({ base, run, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  await browser("close").catch(() => {});
}
