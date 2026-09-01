import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pidFile = path.join(projectRoot, 'data', 'server.pid');

if (!fs.existsSync(pidFile)) {
  console.log('没有发现由本项目启动的后台服务，无需停止。');
  process.exit(0);
}

const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
if (!Number.isInteger(pid) || pid <= 0) {
  fs.unlinkSync(pidFile);
  console.log('已清理无效的服务进程记录。');
  process.exit(0);
}

try {
  process.kill(pid, 0);
} catch {
  fs.unlinkSync(pidFile);
  console.log(`服务进程 ${pid} 已不存在，已清理旧记录。`);
  process.exit(0);
}

console.log(`正在停止服务进程 ${pid}…`);
process.kill(pid, 'SIGTERM');

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    process.kill(pid, 0);
  } catch {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    console.log('服务已停止。');
    process.exit(0);
  }
}

console.error(`服务进程 ${pid} 未能在5秒内退出。请检查该进程后再重试。`);
process.exit(1);
