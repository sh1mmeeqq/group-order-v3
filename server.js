'use strict';
// HTTP + WebSocket сервер. Запуск: npm start  (PORT, DB_FILE, TRUST_PROXY=1 за прокси)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { openDb } = require('./lib/db');
const { Service, AppError } = require('./lib/service');
const { Hub } = require('./lib/hub');
const { attach } = require('./lib/ws');
const { Notifier } = require('./lib/notify');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// Страница итогов пилота для показа владельцу ресторана. Нигде не прилинкована; при задании
// STATS_KEY открывается только по /stats?key=<ключ>.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtRub = (kop) => `${(kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: kop % 100 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
function statsHtml(st, restName = 'Совместные заказы') {
  const tile = (label, value, hint) => `<div class="tile"><span>${esc(label)}</span><b>${esc(value)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  const tiles = [
    tile('Совместных заказов', st.orders, 'оформлено и оплачено'),
    tile('Выручка', fmtRub(st.revenue), 'блюда, доставка и сервис'),
    tile('Средний чек', fmtRub(st.avgCheck), 'на один совместный заказ'),
    tile('Человек в заказе', String(st.avgPeople).replace('.', ','), 'в среднем'),
    tile('Гостей пришло по ссылке', st.guests, 'без установки приложения'),
    tile('Время оформления', st.avgMinutes == null ? '—' : `${String(st.avgMinutes).replace('.', ',')} мин`, 'от создания до оплаты'),
  ].join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="30"><title>Итоги теста</title>
<link rel="stylesheet" href="/app.css"></head><body><main class="stats">
<p class="rest">${esc(restName)}</p><h1>Итоги теста</h1><div class="tiles">${tiles}</div>
<p class="muted note">${st.orders ? 'Считаются только оплаченные совместные заказы.' : 'Пока нет оплаченных совместных заказов. Оформите тестовый заказ, и цифры появятся здесь.'} Страница обновляется сама.</p>
</main></body></html>`;
}

// Форма настройки демо: название, доставка, сервис и меню текстом. Без JS, обычный POST.
// ADMIN_KEY задан -> доступ только с ключом; не задан -> открыто (удобно для локального показа).
function setupHtml(svc, key, msg, base = '') {
  const r = svc.restaurants().find((x) => x.id === svc.activeRestaurantId());
  const rk = svc.get('SELECT key FROM restaurants WHERE id = ?', r.id).key;
  const hid = key ? `<input type="hidden" name="key" value="${esc(key)}">` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow"><title>Настройка демо</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="stats"><p class="rest">Перед показом</p><h1>Настройка демо</h1>
${msg ? `<p class="carry" role="status">${esc(msg)}</p>` : ''}
<form method="post" action="/setup" class="setup">${hid}
<label class="f" for="s-name">Название заведения</label>
<input id="s-name" name="name" maxlength="60" required value="${esc(r.name)}">
<label class="f" for="s-del">Доставка, ₽</label>
<input id="s-del" name="deliveryRub" inputmode="decimal" required value="${esc(String(r.deliveryFee / 100).replace('.', ','))}">
<label class="f" for="s-pct">Сервисный сбор, %</label>
<input id="s-pct" name="servicePct" inputmode="numeric" required value="${esc(r.servicePct)}">
<label class="f" for="s-orig">Сайты ресторана (где будет виджет)</label>
<input id="s-orig" name="origins" maxlength="200" placeholder="site.ru, www.site.ru" value="${esc(r.origins.join(', '))}">
<label class="f" for="s-wa">Как ресторан принимает заказы (необязательно)</label>
<input id="s-wa" name="contactWa" inputmode="tel" maxlength="20" placeholder="WhatsApp: 79001234567">
<input name="contactTg" maxlength="40" placeholder="Telegram: логин без @" aria-label="Telegram ресторана">
<input name="contactTel" inputmode="tel" maxlength="20" placeholder="Телефон: +79001234567" aria-label="Телефон ресторана">
<label class="f" for="s-trial">Пробный период, дней (пусто = без ограничения)</label>
<input id="s-trial" name="trialDays" inputmode="numeric" maxlength="3" placeholder="14" value="">
<label class="f" for="s-menu">Меню: одно блюдо в строке</label>
<p class="hint" style="text-align:left">Категория | Название | Цена | Описание | Вес. Описание и вес можно не писать. «!» после названия: нет в наличии.</p>
<textarea id="s-menu" name="menuText" rows="14" required>${esc(svc.menuText(r.id))}</textarea>
<button class="btn primary wide" type="submit" style="margin-top:14px">Применить</button></form>
<p class="muted note">Ключ заведения: <b>${esc(rk)}</b>. Telegram: ресторан пишет боту <b>/start ${esc(rk)}</b>${r.live ? ' (чат подключён)' : ''}.<br>
Код для сайта: <code>${esc(`<script src="${base}/w.js" data-key="${rk}" defer></script>`)}</code><br>
Прямая ссылка на виджет: <a href="/embed?k=${esc(rk)}">${esc(base)}/embed?k=${esc(rk)}</a></p>
<p class="muted note">Новое заведение сразу появляется у всех. Идущие заказы остаются со своим старым меню.</p>
<p class="muted note"><a href="/">Открыть приложение</a></p>
<h2 style="margin-top:24px">Все заведения</h2>
${svc.all('SELECT id, name, key, tg_chat IS NOT NULL live, trial_until trialUntil FROM restaurants ORDER BY id DESC LIMIT 30').map((x) => {
  const st = x.trialUntil ? (x.trialUntil > svc.now() ? `до ${new Date(x.trialUntil).toLocaleDateString('ru-RU')}` : 'истёк') : 'безлимит';
  return `<div style="margin:8px 0;padding:10px;border:1px solid #8884;border-radius:8px;font-size:13px;word-break:break-all"><b>${esc(x.name)}</b> (${esc(st)}${x.live ? ', TG ✓' : ''})<br>TG: <code>/start ${esc(x.key)}</code> · <a href="/embed?k=${esc(x.key)}">Демо</a><br><code>${esc(`<script src="${base}/w.js" data-key="${x.key}" defer></script>`)}</code></div>`;
}).join('')}
</main></body></html>`;
}

// Юридические страницы /terms, /privacy и /offer.
const OPERATOR = 'плательщик НПД Сахабетдинов Айнур Айдарович, ИНН 165058527980, адрес: Республика Татарстан, г. Набережные Челны, e-mail: yt.namemane@gmail.com';
const LEGAL = {
  '/terms': {
    title: 'Пользовательское соглашение',
    body: `<p>Оператор: ${esc(OPERATOR)}.</p>
<h2>1. Предмет и стороны</h2>
<p>Сервис «Общий заказ» предоставляет программный инструмент (виджет) для совместного выбора блюд, расчёта долей участников и передачи заказа в выбранный заведением канал приёма (Telegram или телефон).</p>
<h2>2. Ограничение роли Оператора</h2>
<p>Оператор не является рестораном, службой доставки или платёжным агентом. Сервис не принимает оплату за блюда и не участвует в расчётах между гостями или между гостем и заведением. За качество блюд, меню, цены и доставку отвечает заведение.</p>
<h2>3. Бесплатный тест (Пилот)</h2>
<p>Заведению предоставляется бесплатный тестовый период на 14 календарных дней. По его окончании доступ продлевается по <a href="/offer">Договору-оферте</a>. Без оплаты доступ просто приостанавливается без штрафов и автосписаний.</p>
<h2>4. Правила и данные</h2>
<p>Пользователь обязуется указывать достоверные данные и не использовать сервис для спама. Обработка персональных данных описана в <a href="/privacy">Политике обработки ПДн</a>.</p>`,
  },
  '/privacy': {
    title: 'Политика обработки персональных данных',
    body: `<p>Оператор: ${esc(OPERATOR)}.</p>
<h2>1. Какие данные мы обрабатываем</h2>
<p>Имя (или псевдоним), номер телефона и адрес доставки (при отправке заказа в ресторан), реквизиты для перевода (если указаны хостом), состав заказа, а также контакты представителей заведений для подключения и оплаты по <a href="/offer">Оферте</a>.</p>
<h2>2. Цели и основание</h2>
<p>Организация совместного заказа, расчёт долей и передача заказа заведению в рамках <a href="/terms">Пользовательского соглашения</a>. Основание — добровольное согласие (отметка чекбокса, по умолчанию выключен) и исполнение договора.</p>
<h2>3. Хранение и удаление (152-ФЗ)</h2>
<p>Базы данных размещены в РФ (г. Москва, хостинг Amvera). Телефон, адрес, реквизиты перевода и текст заказа автоматически обезличиваются через 24 часа после закрытия сессии. Закрытые сессии полностью удаляются из БД через 7 дней. ПДн не пишутся в логи сервера.</p>
<h2>4. Передача и права субъекта</h2>
<p>Данные заказа передаются только заведению, принимающему заказ. Отозвать согласие или запросить удаление данных можно письмом на yt.namemane@gmail.com (ответ до 10 рабочих дней).</p>`,
  },
  '/offer': {
    title: 'Договор-оферта на оказание услуг',
    body: `<p>Исполнитель: ${esc(OPERATOR)}.</p>
<h2>1. Предмет</h2>
<p>Исполнитель предоставляет Заказчику (юрлицу или ИП) доступ к SaaS-виджету «Общий заказ» для приёма совместных заказов на сайте Заказчика. В подписку не входят интеграция с POS/кассами (iiko, r_keeper, Poster) и онлайн-эквайринг.</p>
<h2>2. Акцепт и стоимость</h2>
<p>После 14-дневного пилота по <a href="/terms">Соглашению</a> стоимость доступа составляет <b>2 990 ₽ за 30 календарных дней</b> (НПД, без НДС). Акцептом является 100% предоплата по реквизитам Исполнителя. После оплаты Исполнитель направляет электронный чек из приложения «Мой налог» — он является закрывающим документом.</p>
<h2>3. Продление и возврат</h2>
<p>Автопродления нет: при неоплате следующего месяца виджет приостанавливается. При досрочном отказе возврат за неиспользованные полные дни осуществляется по заявлению на yt.namemane@gmail.com в течение 10 рабочих дней.</p>
<h2>4. Персональные данные</h2>
<p>Обработка данных регулируется <a href="/privacy">Политикой обработки ПДн</a>.</p>`,
  },
};
function legalHtml(page) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark">
<title>${esc(page.title)}</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="stats"><h1>${esc(page.title)}</h1>${page.body}
<p class="muted note"><a href="/terms">Соглашение</a> · <a href="/privacy">Политика ПДн</a> · <a href="/offer">Оферта</a> · <a href="/">Открыть приложение</a></p></main></body></html>`;
}

const HTTP_STATUS = { bad_request: 400, not_found: 404, rate_limited: 429 };

function createApp({ dbFile = process.env.DB_FILE || (fs.existsSync('/data') ? '/data/group-order.db' : path.join(__dirname, 'data', 'group-order.db')), trustProxy = process.env.TRUST_PROXY === '1' } = {}) {
  const clock = { offset: 0, now() { return Date.now() + this.offset; } }; // offset нужен тестам таймера
  const db = openDb(dbFile);
  const svc = new Service(db, clock);
  const hub = new Hub(svc);
  const createLog = new Map(); // ip -> метки времени создания сессий

  const clientIp = (req) => {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function json(res, status, body, extra) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(data);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError('bad_request')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new AppError('bad_request')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new AppError('bad_request')); }
      });
      req.on('error', reject);
    });
  }

  // Статика: файл читается и сжимается один раз (пересборка при смене mtime), клиент ревалидирует по ETag
  // и получает 304 без тела; тексты отдаются в brotli или gzip.
  const fileCache = new Map();
  const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
  function serveFile(req, res, file, extra) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not_found' });
      let c = fileCache.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        const data = fs.readFileSync(file);
        const ext = path.extname(file);
        c = {
          mtime: st.mtimeMs, data,
          etag: '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20) + '"',
          br: COMPRESSIBLE.has(ext) ? zlib.brotliCompressSync(data) : null,
          gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(data, { level: 9 }) : null,
        };
        fileCache.set(file, c);
      }
      const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding', ...SECURITY_HEADERS, ...extra,
      };
      if (extra) delete headers['X-Frame-Options'];
      if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
      const ae = String(req.headers['accept-encoding'] || '');
      let body = c.data;
      if (c.br && /\bbr\b/.test(ae)) { body = c.br; headers['Content-Encoding'] = 'br'; }
      else if (c.gz && /\bgzip\b/.test(ae)) { body = c.gz; headers['Content-Encoding'] = 'gzip'; }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const host = String(req.headers.host || '');
    const baseUrl = (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host;

    if (req.method === 'POST' && p === '/api/sessions') {
      const ip = clientIp(req);
      const now = Date.now();
      const recent = (createLog.get(ip) || []).filter((t) => now - t < 3600e3);
      if (recent.length >= 20) return json(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      const result = svc.createSession(body);
      recent.push(now);
      createLog.set(ip, recent);
      return json(res, 201, result);
    }
    const mk = /^\/api\/r\/([\w-]{6,32})\/menu$/.exec(p);
    const st = /^\/api\/r\/([\w-]{6,32})\/status$/.exec(p);
    if (req.method === 'GET' && st) { // для кнопки виджета на чужом сайте: показывать ли её
      const rest = svc.restaurantByKey(st[1]);
      return json(res, rest ? 200 : 404, { active: !!(rest && rest.active) }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && mk) {
      const rest = svc.restaurantByKey(mk[1]);
      if (!rest) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { restaurant: rest, menu: svc.menu(rest.id) });
    }
    if (req.method === 'GET' && p === '/api/restaurants') return json(res, 200, svc.restaurants());
    const m = /^\/api\/restaurants\/(\d+)\/menu$/.exec(p);
    if (req.method === 'GET' && m) {
      const id = Number(m[1]);
      const rest = svc.restaurants().find((r) => r.id === id);
      if (!rest) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { restaurant: rest, menu: svc.menu(id) });
    }
    if (req.method === 'GET' && p === '/api/active/menu') {
      const id = svc.activeRestaurantId();
      return json(res, 200, { restaurant: svc.restaurants().find((r) => r.id === id), menu: svc.menu(id) });
    }
    if (p === '/setup' && (req.method === 'GET' || req.method === 'POST')) {
      const admin = process.env.ADMIN_KEY;
      const sendHtml = (status, html) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(html);
      };
      if (req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (admin && key !== admin) return json(res, 404, { error: 'not_found' });
        return sendHtml(200, setupHtml(svc, key, '', baseUrl));
      }
      const form = new URLSearchParams(await readBody(req, 32768));
      const key = form.get('key') || '';
      if (admin && key !== admin) return json(res, 404, { error: 'not_found' });
      try {
        const r = svc.configureDemo({ name: form.get('name'), deliveryRub: form.get('deliveryRub'),
          servicePct: form.get('servicePct'), menuText: form.get('menuText'), origins: form.get('origins'), trialDays: form.get('trialDays'),
          contactWa: form.get('contactWa'), contactTg: form.get('contactTg'), contactTel: form.get('contactTel') });
        return sendHtml(200, setupHtml(svc, key, `Готово: заведение обновлено, блюд в меню: ${r.items}.`, baseUrl));
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        const where = e.extra.line ? `, строка ${e.extra.line}: ${e.extra.why}` : e.extra.why ? `: ${e.extra.why}` : '';
        return sendHtml(400, setupHtml(svc, key, `Не получилось. Проверьте поле «${e.extra.field || ''}»${where}`, baseUrl));
      }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && LEGAL[p]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : legalHtml(LEGAL[p]));
    }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/stats') {
      const key = process.env.STATS_KEY;
      if (key && url.searchParams.get('key') !== key) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(statsHtml(svc.stats()));
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // Во фрейме страницу можно показывать только на сайтах заведения (frame-ancestors).
      const framed = (origins) => origins.length ? { 'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'",
        'frame-ancestors ' + origins.flatMap((h) => /^localhost/.test(h) ? ['http://' + h, 'https://' + h] : ['https://' + h]).join(' ')) } : undefined;
      if (p === '/embed') {
        const rest = svc.restaurantByKey(url.searchParams.get('k'));
        return serveFile(req, res, path.join(PUBLIC, 'app.html'), rest && framed(rest.origins));
      }
      const jm = /^\/j\/([A-Za-z0-9]{6})$/.exec(p);
      if (jm) {
        const sess = svc.session(jm[1].toUpperCase());
        const rest = sess && svc.restaurants().find((r) => r.id === sess.restaurant_id);
        return serveFile(req, res, path.join(PUBLIC, 'app.html'), rest && framed(rest.origins));
      }
      if (p === '/' || p === '/host' || /^\/host\/[A-Za-z0-9]{6}$/.test(p)) {
        return serveFile(req, res, path.join(PUBLIC, 'app.html'));
      }
      const file = path.normalize(path.join(PUBLIC, p));
      if (file.startsWith(PUBLIC + path.sep) && path.basename(file) !== 'app.html') return serveFile(req, res, file);
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof AppError) return json(res, HTTP_STATUS[e.code] || 400, { error: e.code, ...e.extra });
      console.error('[http] internal error:', e);
      json(res, 500, { error: 'internal' });
    });
  });

  const wss = attach(server, {
    path: '/ws',
    onConnection: (conn) => hub.onConnection(conn),
    // Защита от cross-site WebSocket hijacking: браузерный Origin должен совпадать с Host.
    verifyOrigin: (req) => {
      const origin = req.headers.origin;
      if (!origin) return true; // не браузерные клиенты
      // За прокси Amvera Host может быть переписан — учитываем X-Forwarded-Host.
      const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
      try {
        const h = new URL(origin).host.toLowerCase();
        return h === String(req.headers.host || '').toLowerCase() || (!!fwd && h === fwd);
      } catch { return false; }
    },
  });

  const ticker = setInterval(() => {
    try { hub.tick(); } catch (e) { console.error('[tick]', e); }
  }, 1000);
  ticker.unref();

  return {
    server, hub, svc, db, clock,
    close() {
      clearInterval(ticker);
      wss.closeAll();
      server.close();
      db.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  const notifier = new Notifier(app.svc);
  notifier.start();
  app.server.listen(port, () => {
    console.log(`Real-Time Group Order: http://localhost:${port}/host`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { notifier.stop(); app.close(); process.exit(0); });
}

module.exports = { createApp };
