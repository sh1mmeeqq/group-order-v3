'use strict';
// Виджет для чужих сайтов: ключи ресторанов, заказ в Telegram с повторами, защита встраивания.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Notifier } = require('../lib/notify');

async function boot() {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { app, port, base };
}
const ws = (port) => {
  const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { s, state: null, errors: [] };
  s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'state') c.state = m; if (m.t === 'error') c.errors.push(m); };
  c.open = new Promise((r) => { s.onopen = r; });
  c.send = (o) => s.send(JSON.stringify(o));
  c.until = async (fn) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout ' + JSON.stringify(c.errors)); };
  return c;
};

// Ресторан с ключом, меню и привязанным чатом; хост кладёт блюдо и блокирует корзину.
async function lockedOrder(app, port, key) {
  const rest = app.svc.restaurantByKey(key);
  const menu = app.svc.menu(rest.id);
  const r = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restaurantId: rest.id, hostName: 'Олег' }) })).json();
  const host = ws(port);
  await host.open;
  host.send({ t: 'hello', code: r.code, token: r.hostToken });
  await host.until(() => host.state && host.state.me);
  host.send({ t: 'set_item', menuItemId: menu[0].id, qty: 2 });
  await host.until(() => host.state.session.units === 2);
  host.send({ t: 'lock' });
  await host.until(() => host.state.session.phase === 'locked');
  return { host, menu, code: r.code };
}

const SETUP = { name: 'Тест-пицца', deliveryRub: '100', servicePct: 0, menuText: 'Пицца | Маргарита | 500', origins: 'https://Pizza.ru/menu, www.pizza.ru' };

test('configureDemo выдаёт ключ, домены нормализуются, меню отдаётся по ключу', async () => {
  const { app, base } = await boot();
  const r = app.svc.configureDemo(SETUP);
  assert.match(r.key, /^[\w-]{12}$/);
  const d = await (await fetch(`${base}/api/r/${r.key}/menu`)).json();
  assert.deepStrictEqual(d.restaurant.origins, ['pizza.ru', 'www.pizza.ru']);
  assert.strictEqual(d.menu[0].name, 'Маргарита');
  assert.strictEqual((await fetch(`${base}/api/r/${'x'.repeat(12)}/menu`)).status, 404);
  assert.throws(() => app.svc.configureDemo({ ...SETUP, origins: 'bad host!' }), /bad_request/);
  app.close();
});

test('без Telegram заказ ведёт себя как раньше (демо), с Telegram нужны телефон и адрес', async () => {
  const { app, port } = await boot();
  const { key } = app.svc.configureDemo(SETUP);
  const a = await lockedOrder(app, port, key);
  a.host.send({ t: 'pay' });
  await a.host.until(() => a.host.state.session.phase === 'paid');
  assert.strictEqual(app.svc.all('SELECT * FROM outbox').length, 0);

  const rid = app.svc.restaurantByKey(key).id;
  app.svc.run('UPDATE restaurants SET tg_chat = ? WHERE id = ?', '777', rid);
  const b = await lockedOrder(app, port, key);
  b.host.send({ t: 'pay' });
  await b.host.until(() => b.host.errors.length);
  assert.strictEqual(b.host.state.session.phase, 'locked');
  b.host.send({ t: 'pay', phone: '12', address: 'ул. Ленина 1' });
  await b.host.until(() => b.host.errors.length > 1);
  b.host.send({ t: 'pay', phone: '+7 900 111-22-33', address: 'ул. Ленина 1, кв. 5' });
  await b.host.until(() => b.host.state.session.phase === 'paid');
  const [row] = app.svc.all('SELECT * FROM outbox');
  assert.strictEqual(row.chat, '777');
  assert.match(row.text, /\[Совместный заказ · 1 чел\.\]/);
  assert.match(row.text, /\+7 900 111-22-33/);
  assert.match(row.text, /Олег:\n {2}.+ × 2/);
  assert.match(row.text, /Итого: 1\s?100 ₽/); // 2 × 500 + доставка 100
  app.close();
});

test('Notifier: повтор после сбоя, сообщение не теряется, привязка по /start КЛЮЧ', async () => {
  const { app, port } = await boot();
  const { key } = app.svc.configureDemo(SETUP);
  const calls = [];
  let fail = true;
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    if (url.endsWith('/getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
      { update_id: 5, message: { text: `/start ${key}`, chat: { id: 4242 } } },
      { update_id: 6, message: { text: '/start WRONGKEY1', chat: { id: 1 } } }] }) };
    if (fail && body.chat_id === '4242') return { ok: false, status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  const n = new Notifier(app.svc, { token: 'T', base: 'https://tg.test', fetchFn });
  await n.poll();
  assert.strictEqual(app.svc.get('SELECT tg_chat t FROM restaurants WHERE key = ?', key).t, '4242');
  assert.strictEqual(n.offset, 7);
  assert.ok(calls.some((c) => c.body.text && /Ключ не подошёл/.test(c.body.text)));

  const o = await lockedOrder(app, port, key);
  o.host.send({ t: 'pay', phone: '+79001112233', address: 'Казань, ул. Баумана 1' });
  await o.host.until(() => o.host.state.session.phase === 'paid');

  assert.strictEqual(await n.flush(), 0);                       // Telegram недоступен
  let row = app.svc.get('SELECT * FROM outbox');
  assert.strictEqual(row.status, 'new'); assert.strictEqual(row.attempts, 1);
  assert.match(row.error, /502/);
  assert.strictEqual(await n.flush(), 0);                       // ещё рано: пауза 10 с
  fail = false;
  app.clock.offset += 11000;
  assert.strictEqual(await n.flush(), 1);
  row = app.svc.get('SELECT * FROM outbox');
  assert.strictEqual(row.status, 'sent');
  assert.ok(calls.some((c) => c.url === 'https://tg.test/botT/sendMessage' && c.body.chat_id === '4242' && /Баумана/.test(c.body.text)));
  app.close();
});

test('после 6 неудач заказ помечается failed', async () => {
  const { app } = await boot();
  app.svc.run('INSERT INTO outbox (session_id, chat, text, next_at) VALUES (1, ?, ?, 0)', '1', 'x');
  const n = new Notifier(app.svc, { token: 'T', fetchFn: async () => { throw new Error('down'); } });
  const quiet = console.error; console.error = () => {};
  for (let i = 0; i < 6; i++) { app.clock.offset += 3600e3 * 2; await n.flush(); }
  console.error = quiet;
  assert.strictEqual(app.svc.get('SELECT status s FROM outbox').s, 'failed');
  app.close();
});

test('встраивание: фрейм разрешён только сайтам ресторана', async () => {
  const { app, base } = await boot();
  const { key } = app.svc.configureDemo(SETUP);
  const e = await fetch(`${base}/embed?k=${key}`);
  const csp = e.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors https:\/\/pizza\.ru https:\/\/www\.pizza\.ru;/);
  assert.strictEqual(e.headers.get('x-frame-options'), null);
  const bad = await fetch(`${base}/embed?k=nope12345678`);
  assert.match(bad.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match((await fetch(`${base}/host`)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const w = await fetch(`${base}/w.js`);
  assert.strictEqual(w.status, 200);
  assert.match(w.headers.get('content-type'), /javascript/);
  app.close();
});

test('миграция: старая БД без ключей получает ключи, данные целы', () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'go-')), 'old.db');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE restaurants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, delivery_fee INTEGER NOT NULL DEFAULT 0, service_fee_pct INTEGER NOT NULL DEFAULT 0);
          INSERT INTO restaurants (name) VALUES ('Старое'), ('Второе');`);
  d.close();
  const app = createApp({ dbFile: file });
  const rows = app.svc.all('SELECT name, key FROM restaurants ORDER BY id');
  assert.deepStrictEqual(rows.map((r) => r.name), ['Старое', 'Второе']);
  assert.ok(rows.every((r) => r.key && r.key.length === 12) && rows[0].key !== rows[1].key);
  app.close();
});
