#!/usr/bin/env bun
// Runs the term-ui server as a user service so it outlives the terminal (or omp session) that launched it.
// usage: bun term-ui/service.ts install|uninstall|status
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readToken } from "./token";

const LABEL = "ai.io-ai.term-ui";
const UNIT = "io-ai-term-ui";
const SERVER = resolve(import.meta.dir, "server.ts");
const IO = resolve(import.meta.dir, "..");
const PORT = process.env.PORT ?? "8787";
const uid = process.getuid?.() ?? 0;

const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logPath = join(homedir(), "Library", "Logs", "io-ai-term-ui.log");
const unitPath = join(homedir(), ".config", "systemd", "user", `${UNIT}.service`);

const xml = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Environment baked into the service: PATH (omp, bun) plus the optional overrides of this shell.
function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const key of ["ORCH_HOME", "PORT"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function plistContent(): string {
  const env = Object.entries(serviceEnv()).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(SERVER)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(IO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export function unitContent(): string {
  const env = Object.entries(serviceEnv()).map(([k, v]) => `Environment=${JSON.stringify(`${k}=${v}`)}`).join("\n");
  return `[Unit]
Description=io-ai term-ui

[Service]
ExecStart=${process.execPath} ${SERVER}
WorkingDirectory=${IO}
${env}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
}

async function must(cmd: string[]) {
  const r = await run(cmd);
  if (r.code !== 0) fail(`${cmd.join(" ")} failed (${r.code}): ${r.out}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function probe(): Promise<string> {
  const token = readToken(process.env.ORCH_HOME ?? join(homedir(), "orch"));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/global-issues`, { headers: { authorization: `Bearer ${token ?? ""}` }, signal: AbortSignal.timeout(3000) });
    return r.ok ? `answering on :${PORT}; login: http://127.0.0.1:${PORT}/login?t=${token}` : `HTTP ${r.status} on :${PORT}`;
  } catch {
    return `no answer on :${PORT}`;
  }
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function darwin(action: string) {
  const target = `gui/${uid}`;
  if (action === "install") {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFile(plistPath, plistContent());
    let r = await run(["launchctl", "bootstrap", target, plistPath]);
    if (r.code !== 0) {
      await run(["launchctl", "bootout", `${target}/${LABEL}`]); // label already loaded: reload it once
      r = await run(["launchctl", "bootstrap", target, plistPath]);
    }
    if (r.code !== 0) fail(`launchctl bootstrap failed: ${r.out}`);
    console.log(`installed ${plistPath}; logs: ${logPath}`);
  } else if (action === "uninstall") {
    await run(["launchctl", "bootout", `${target}/${LABEL}`]);
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log("uninstalled");
  } else {
    const r = await run(["launchctl", "print", `${target}/${LABEL}`]);
    console.log(`service: ${r.code === 0 ? "loaded" : "not loaded"}; server: ${await probe()}`);
    process.exitCode = r.code === 0 ? 0 : 1;
  }
}

async function linux(action: string) {
  if (action === "install") {
    writeFile(unitPath, unitContent());
    await must(["systemctl", "--user", "daemon-reload"]);
    await must(["systemctl", "--user", "enable", "--now", UNIT]);
    console.log(`installed ${unitPath}`);
  } else if (action === "uninstall") {
    await run(["systemctl", "--user", "disable", "--now", UNIT]);
    if (existsSync(unitPath)) unlinkSync(unitPath);
    await run(["systemctl", "--user", "daemon-reload"]);
    console.log("uninstalled");
  } else {
    const r = await run(["systemctl", "--user", "is-active", UNIT]);
    console.log(`service: ${r.out}; server: ${await probe()}`);
    process.exitCode = r.code === 0 ? 0 : 1;
  }
}

if (import.meta.main) {
  const action = process.argv[2];
  if (!["install", "uninstall", "status"].includes(action)) fail("usage: bun term-ui/service.ts install|uninstall|status");
  if (process.platform === "win32") fail("service install is not supported on Windows yet");
  else if (process.platform === "darwin") await darwin(action);
  else await linux(action);
}
