import tls from 'node:tls';

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function createResponseReader(socket, timeoutMs = 15_000) {
  let buffer = '';
  let current = [];
  const queue = [];
  const waiters = [];

  function deliver(response) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(response);
    else queue.push(response);
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      current.push(line);
      if (/^\d{3} /.test(line)) {
        deliver({ code: Number(line.slice(0, 3)), lines: current });
        current = [];
      }
    }
  });

  socket.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });

  return function nextResponse() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP响应超时')), timeoutMs);
      waiters.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  };
}

function expect(response, allowed, command) {
  if (!allowed.includes(response.code)) {
    throw new Error(`SMTP ${command}失败：${response.lines.join(' | ')}`);
  }
}

export async function sendSmtpMail(config, { subject, text }) {
  if (!config.secure) {
    throw new Error('当前内置SMTP客户端仅支持TLS直连，请使用465端口或关闭邮件通知');
  }
  for (const field of ['host', 'username', 'password', 'from', 'to']) {
    if (!config[field]) throw new Error(`SMTP配置缺少${field}`);
  }

  const socket = tls.connect({
    host: config.host,
    port: config.port,
    servername: config.host,
    rejectUnauthorized: true
  });
  const nextResponse = createResponseReader(socket);
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  async function command(value, allowed, label) {
    socket.write(`${value}\r\n`);
    const response = await nextResponse();
    expect(response, allowed, label);
  }

  try {
    expect(await nextResponse(), [220], '连接');
    await command(`EHLO localhost`, [250], 'EHLO');
    const token = Buffer.from(`\0${config.username}\0${config.password}`).toString('base64');
    await command(`AUTH PLAIN ${token}`, [235], '认证');
    await command(`MAIL FROM:<${sanitizeHeader(config.from)}>`, [250], '发件人');
    await command(`RCPT TO:<${sanitizeHeader(config.to)}>`, [250, 251], '收件人');
    await command('DATA', [354], 'DATA');

    const safeText = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      `From: ${sanitizeHeader(config.from)}`,
      `To: ${sanitizeHeader(config.to)}`,
      `Subject: ${sanitizeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      safeText,
      '.'
    ].join('\r\n');
    await command(message, [250], '邮件正文');
    await command('QUIT', [221], 'QUIT');
  } finally {
    socket.end();
  }
}
