import { spawn } from 'node:child_process';
import { config } from './config.js';
import { nowIso, toPlain } from './db.js';
import { sendSmtpMail } from './smtp.js';

function appleScriptString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

async function sendMacosNotification(title, body) {
  if (process.platform !== 'darwin') return false;
  const script = `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`;
  await new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`osascript退出码${code}`)));
  });
  return true;
}

export async function createNotification(db, input) {
  const timestamp = nowIso();
  const result = db.prepare(`
    INSERT INTO notifications (
      ticker, severity, category, title, body, evidence_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'UNREAD', ?)
  `).run(
    input.ticker || null,
    input.severity || 'INFO',
    input.category || 'SYSTEM',
    input.title,
    input.body,
    JSON.stringify(input.evidence || []),
    timestamp
  );
  const id = Number(result.lastInsertRowid);

  if (config.notifications.macosEnabled) {
    try {
      if (await sendMacosNotification(input.title, input.body)) {
        db.prepare('UPDATE notifications SET macos_sent_at = ? WHERE id = ?').run(nowIso(), id);
      }
    } catch (error) {
      console.error('macOS通知失败：', error.message);
    }
  }

  if (config.notifications.emailEnabled) {
    try {
      await sendSmtpMail(config.notifications.smtp, {
        subject: `[${input.severity || 'INFO'}] ${input.title}`,
        text: input.body
      });
      db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').run(nowIso(), id);
    } catch (error) {
      console.error('邮件通知失败：', error.message);
    }
  }

  return toPlain(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id));
}
