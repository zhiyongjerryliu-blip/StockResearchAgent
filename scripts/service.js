import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.stockresearchagent.local';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const domain = uid == null ? null : `gui/${uid}`;
const serviceTarget = domain ? `${domain}/${label}` : null;
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(projectRoot, 'data', 'logs');
const stdoutPath = path.join(logDir, 'server.log');
const stderrPath = path.join(logDir, 'server-error.log');
const pidFile = path.join(projectRoot, 'data', 'server.pid');

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistContent() {
  const executableDir = path.dirname(process.execPath);
  const executablePath = [
    executableDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'
  ].filter((item, index, values) => values.indexOf(item) === index).join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>--env-file-if-exists=.env</string>
    <string>${xml(path.join(projectRoot, 'src', 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    const message = String(result.stderr || result.stdout || '').trim();
    throw new Error(message || `launchctl ${args.join(' ')} 执行失败`);
  }
  return result;
}

function loaded() {
  if (!serviceTarget) return false;
  return launchctl(['print', serviceTarget], true).status === 0;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function bootout() {
  if (!loaded()) return;
  launchctl(['bootout', serviceTarget]);
  const deadline = Date.now() + 5000;
  while (loaded() && Date.now() < deadline) pause(100);
  if (loaded()) throw new Error('LaunchAgent 未能在5秒内完成卸载');
}

function bootstrap() {
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = launchctl(['bootstrap', domain, plistPath], true);
    if (lastResult.status === 0) return;
    pause(attempt * 500);
  }
  const message = String(lastResult?.stderr || lastResult?.stdout || '').trim();
  throw new Error(message || 'LaunchAgent 注册失败');
}

function rotateLog(filePath, maximumBytes = 10 * 1024 * 1024, copies = 3) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maximumBytes) return;
  for (let index = copies - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

function ensureServiceFiles() {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const content = plistContent();
  if (!fs.existsSync(plistPath) || fs.readFileSync(plistPath, 'utf8') !== content) {
    fs.writeFileSync(plistPath, content, { encoding: 'utf8', mode: 0o644 });
  }
}

function clearStalePidFile() {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
    else fs.unlinkSync(pidFile);
  } catch (error) {
    if (error.code === 'ESRCH') fs.unlinkSync(pidFile);
  }
}

function start() {
  bootout();
  clearStalePidFile();
  ensureServiceFiles();
  rotateLog(stdoutPath);
  rotateLog(stderrPath);
  bootstrap();
  console.log(`StockResearchAgent 已由 launchd 启动：http://127.0.0.1:3789`);
  console.log(`运行日志：${stdoutPath}`);
  console.log(`错误日志：${stderrPath}`);
}

function stop() {
  if (!loaded()) {
    clearStalePidFile();
    console.log('StockResearchAgent 当前未运行。');
    return;
  }
  bootout();
  clearStalePidFile();
  console.log('StockResearchAgent 已停止。');
}

function status() {
  clearStalePidFile();
  let pid = null;
  if (fs.existsSync(pidFile)) pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  console.log(JSON.stringify({
    label,
    loaded: loaded(),
    pid: Number.isInteger(pid) ? pid : null,
    url: 'http://127.0.0.1:3789',
    stdoutPath,
    stderrPath
  }, null, 2));
}

function uninstall() {
  bootout();
  clearStalePidFile();
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log('StockResearchAgent LaunchAgent 已卸载，研究数据库和日志未删除。');
}

if (process.platform !== 'darwin' || !domain) {
  console.error('常驻服务管理仅支持 macOS；其他系统请使用 npm run start:foreground。');
  process.exit(1);
}

const command = process.argv[2] || 'status';
try {
  if (['start', 'install', 'restart'].includes(command)) start();
  else if (command === 'stop') stop();
  else if (command === 'status') status();
  else if (command === 'uninstall') uninstall();
  else throw new Error(`未知服务命令：${command}`);
} catch (error) {
  console.error(`StockResearchAgent 服务操作失败：${error.message}`);
  process.exit(1);
}
