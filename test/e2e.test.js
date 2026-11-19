'use strict';
// Сквозные тесты: настоящие HTTP и WebSocket, время двигается через clock.offset.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');
const { splitProportional } = require('../lib/service');

async function boot() {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path, body) => {
    const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const menu = (await api('/api/restaurants/1/menu')).body.menu;
  const dish = (name) => menu.find((m) => m.name === name);
  return { app, port, api, dish, menu, base };
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, state: null, msgs: [], errors: [], events: [], closed: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    if (m.t === 'state') c.state = m;
    if (m.t === 'error') c.errors.push(m);
    if (m.t === 'event') c.events.push(m);
  };
  ws.onclose = (e) => { c.closed = e.code; };
  c.open = new Promise((res) => { ws.onopen = res; });
  c.send = (o) => ws.send(JSON.stringify(o));
  const until = async (fn, what, ms = 2000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}; phase=${c.state?.session.phase}; errors=${JSON.stringify(c.errors)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  c.waitState = (pred, what) => until(() => c.state && pred(c.state) && c.state, what);
  c.waitError = (code) => until(() => c.errors.find((e) => e.code === code), `error ${code}`);
  c.waitMsg = (t) => until(() => c.msgs.find((m) => m.t === t), `message ${t}`);
  c.mine = (s = c.state) => s.participants.find((p) => p.id === s.me.id);
  return c;
}

async function hostOf(port, api, body = {}) {
  const r = (await api('/api/sessions', { restaurantId: 1, hostName: 'Олег', ...body })).body;
  const c = client(port);
  await c.open;
  c.send({ t: 'hello', code: r.code, token: r.hostToken });
  await c.waitState((s) => s.me, 'host state');
  return { host: c, code: r.code, hostToken: r.hostToken };
}

async function guestOf(port, code, name) {
  const c = client(port);
  await c.open;
  c.send({ t: 'hello', code });
  await c.waitMsg('anon');
  c.send({ t: 'join', name });
  const w = await c.waitMsg('welcome');
  const st = await c.waitState((s) => s.me, 'guest state');
  c.token = (await (async () => c.msgs.find((m) => m.token))()).token;
  return c;
}

test('splitProportional: сумма долей всегда равна общей сумме', () => {
  for (let i = 0; i < 500; i++) {
    const w = Array.from({ length: 1 + Math.floor(Math.random() * 8) }, () => 1 + Math.floor(Math.random() * 100000));
    const total = Math.floor(Math.random() * 60000);
    const parts = splitProportional(total, w);
    assert.strictEqual(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(parts.every((x) => x >= 0));
  }
  assert.deepStrictEqual(splitProportional(100, [1, 1, 1]), [34, 33, 33]);
});

test('полный сценарий: гости по ссылке → реальное время → права → лимит → блокировка → оплата → Split Bill', async () => {
  const { app, port, api, dish } = await boot();
  try {
    const { host, code } = await hostOf(port, api, { limitRub: 1000 });
    assert.strictEqual(host.state.session.phase, 'waiting');
    assert.strictEqual(host.state.me.isHost, true);

    // Гость открывает ссылку: видит превью, вводит только имя
    const anya = await guestOf(port, code, 'Аня');
    const preview = anya.msgs.find((m) => m.t === 'anon').preview;
    assert.strictEqual(preview.hostName, 'Олег');
    const bob = await guestOf(port, code, 'аня'); // то же имя → суффикс
    await host.waitState((s) => s.participants.length === 3, 'three participants');
    assert.deepStrictEqual(host.state.participants.map((p) => p.name), ['Олег', 'Аня', 'аня 2']);
    assert.strictEqual(host.state.session.phase, 'selecting');

    // Блюдо гостя без перезагрузки появляется у хоста и у другого гостя
    const margarita = dish('Маргарита');
    anya.send({ t: 'set_item', menuItemId: margarita.id, qty: 1 });
    const hs = await host.waitState((s) => s.participants[1].items.length === 1, 'item on host');
    assert.strictEqual(hs.participants[1].items[0].name, 'Маргарита');
    assert.strictEqual(hs.participants[1].subtotal, 52000);
    await bob.waitState((s) => s.participants[1].items.length === 1, 'item on other guest');
    assert.ok(host.events.some((e) => e.kind === 'item_added' && e.by === 'Аня'), 'хост получил событие для тоста');

    // Чужое менять нельзя
    bob.send({ t: 'set_item', menuItemId: margarita.id, qty: 0, targetId: anya.state.me.id });
    await bob.waitError('forbidden');

    // Лимит 1000 ₽: вторая пицца (1040 ₽) не влезает, в ответе есть остаток
    anya.send({ t: 'set_item', menuItemId: margarita.id, qty: 2 });
    const lim = await anya.waitError('limit_exceeded');
    assert.strictEqual(lim.remaining, 48000);
    assert.strictEqual(host.state.participants[1].items[0].qty, 1);

    // Недоступное блюдо
    anya.send({ t: 'set_item', menuItemId: dish('Четыре сыра').id, qty: 1 });
    await anya.waitError('item_unavailable');

    // Цена только серверная: лишние поля из сообщения игнорируются
    bob.send({ t: 'set_item', menuItemId: dish('Лимонад домашний').id, qty: 1, price: 1, unit_price: 1 });
    const s2 = await host.waitState((s) => s.participants[2].items.length === 1, 'bob item');
    assert.strictEqual(s2.participants[2].items[0].price, dish('Лимонад домашний').price);

    // Гость не управляет заказом
    for (const t of ['lock', 'pay', 'close', 'extend']) anya.send({ t, minutes: 5 });
    anya.send({ t: 'kick', participantId: bob.state.me.id });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(anya.errors.filter((e) => e.code === 'forbidden').length, 5);
    assert.strictEqual(host.state.session.phase, 'selecting');

    // Хост правит чужую позицию (убирает лимонад Бориса) и добавляет своё
    host.send({ t: 'set_item', menuItemId: dish('Лимонад домашний').id, qty: 0, targetId: bob.state.me.id });
    await host.waitState((s) => s.participants[2].items.length === 0, 'host removed guest item');
    host.send({ t: 'set_item', menuItemId: dish('Карбонара').id, qty: 1 });
    await host.waitState((s) => s.participants[0].items.length === 1, 'host item');

    // Блокировка: гость больше ничего не меняет, видит фазу locked
    host.send({ t: 'lock' });
    await anya.waitState((s) => s.session.phase === 'locked', 'locked');
    assert.strictEqual(anya.state.me.canEdit, false);
    anya.send({ t: 'set_item', menuItemId: margarita.id, qty: 0 });
    await anya.waitError('session_locked');
    host.send({ t: 'set_item', menuItemId: margarita.id, qty: 0, targetId: anya.state.me.id });
    await host.waitError('session_locked'); // хост тоже: сначала разблокировать

    host.send({ t: 'unlock' });
    await anya.waitState((s) => s.session.phase === 'selecting', 'unlocked');
    host.send({ t: 'lock' });
    await host.waitState((s) => s.session.phase === 'locked', 'locked again');
    host.send({ t: 'pay' });
    const paid = await host.waitState((s) => s.session.phase === 'paid', 'paid');

    // Split Bill: Аня 520 ₽ + Олег 540 ₽ = 1060 ₽; сервис 5% = 53 ₽; доставка 199 ₽ → 1312 ₽
    assert.strictEqual(paid.session.total, 106000);
    assert.strictEqual(paid.session.serviceFee, 5300);
    assert.strictEqual(paid.session.deliveryFee, 19900);
    assert.strictEqual(paid.session.grandTotal, 131200);
    assert.strictEqual(paid.settlement.reduce((a, r) => a + r.amount, 0), 131200);
    assert.strictEqual(paid.settlement.find((r) => r.isHost).status, 'paid');
    const anyaRow = paid.settlement.find((r) => r.name === 'Аня');
    assert.strictEqual(anyaRow.status, 'owes');
    assert.strictEqual(anyaRow.itemsTotal, 52000);

    // Гость получает только свою строку расчёта, хост — все
    const gs = await anya.waitState((s) => s.session.phase === 'paid', 'guest sees paid');
    assert.strictEqual(gs.settlement.length, 1);
    assert.strictEqual(gs.settlement[0].name, 'Аня');
    assert.strictEqual(paid.settlement.length, 2);

    host.send({ t: 'mark_debt', participantId: anya.state.me.id, status: 'paid' });
    await anya.waitState((s) => s.settlement.find((r) => r.name === 'Аня').status === 'paid', 'debt marked');

    // После оплаты по ссылке больше не войти
    const late = client(port);
    await late.open;
    late.send({ t: 'hello', code });
    await late.waitError('session_finished');

    // Воронка событий записана для KPI
    const types = app.db.prepare('SELECT type, COUNT(*) n FROM events GROUP BY type').all();
    const n = Object.fromEntries(types.map((r) => [r.type, r.n]));
    assert.strictEqual(n.group_order_created, 1);
    assert.strictEqual(n.guest_name_entered, 2);
    assert.strictEqual(n.guest_first_item_added, 2);
    assert.strictEqual(n.guest_limit_hit, 1);
    assert.strictEqual(n.cart_locked, 2);
    assert.strictEqual(n.cart_unlocked, 1);
    assert.strictEqual(n.group_order_paid, 1);
    assert.strictEqual(n.debt_marked_paid, 1);
    // Скрипт метрик из бизнес-плана считает воронку по тому же журналу
    const f = require('../scripts/metrics').funnel(app.db);
    assert.strictEqual(f.sessionsCreated, 1);
    assert.strictEqual(f.sessionsPaid, 1);
    assert.strictEqual(f.guestsNamed, 2);
    assert.strictEqual(f.namedToItemPct, 100);
    assert.strictEqual(f.createdToPaidPct, 100);
    assert.strictEqual(f.limitUsedPct, 100);
    assert.strictEqual(f.timerUsedPct, 0);
    assert.strictEqual(f.limitHits, 1);
    for (const c of [host, anya, bob, late]) c.ws.close();
  } finally {
    app.close();
  }
});

test('нельзя заблокировать пустую корзину', async () => {
  const { app, port, api } = await boot();
  try {
    const { host } = await hostOf(port, api);
    host.send({ t: 'lock' });
    await host.waitError('cart_empty');
    host.ws.close();
  } finally {
    app.close();
  }
});

test('таймер: после истечения гости не добавляют, хост продлевает', async () => {
  const { app, port, api, dish } = await boot();
  try {
    const { host, code } = await hostOf(port, api, { timerMin: 10 });
    const guest = await guestOf(port, code, 'Боря');
    assert.ok(guest.state.session.deadlineAt > guest.state.now);

    app.clock.offset += 10 * 60000 + 1000;
    app.hub.tick();
    await guest.waitState((s) => s.session.phase === 'time_up', 'time_up');
    assert.strictEqual(guest.state.me.canEdit, false);

    guest.send({ t: 'set_item', menuItemId: dish('Хумус с лепёшкой').id, qty: 1 });
    await guest.waitError('time_up');
    host.send({ t: 'set_item', menuItemId: dish('Хумус с лепёшкой').id, qty: 1 }); // хосту можно
    await host.waitState((s) => s.participants[0].items.length === 1, 'host adds after time up');

    host.send({ t: 'extend', minutes: 5 });
    await guest.waitState((s) => s.session.phase === 'selecting', 'extended');
    guest.send({ t: 'set_item', menuItemId: dish('Хумус с лепёшкой').id, qty: 1 });
    await host.waitState((s) => s.participants[1].items.length === 1, 'guest adds again');
    host.ws.close(); guest.ws.close();
  } finally {
    app.close();
  }
});

test('исключение гостя, повторный вход по токену, закрытие сессии', async () => {
  const { app, port, api, dish } = await boot();
  try {
    const { host, code } = await hostOf(port, api);
    const guest = await guestOf(port, code, 'Гость');
    guest.send({ t: 'set_item', menuItemId: dish('Болоньезе').id, qty: 1 });
    await host.waitState((s) => s.participants[1]?.items.length === 1, 'item');

    // Гость обновил страницу: тот же токен возвращает в ту же сессию
    const again = client(port);
    await again.open;
    again.send({ t: 'hello', code, token: guest.token });
    const back = await again.waitState((s) => s.me, 'rejoin');
    assert.strictEqual(back.me.name, 'Гость');
    assert.strictEqual(back.participants[1].items.length, 1);

    host.send({ t: 'kick', participantId: guest.state.me.id });
    await host.waitState((s) => s.participants.length === 1 && s.session.total === 0, 'kicked, items gone');
    await guest.waitMsg('kicked');

    const retry = client(port);
    await retry.open;
    retry.send({ t: 'hello', code, token: guest.token });
    await retry.waitMsg('kicked');

    const bad = client(port);
    await bad.open;
    bad.send({ t: 'hello', code, token: 'x'.repeat(32) });
    await bad.waitMsg('anon'); // чужой токен = обычный новый гость, без доступа к чужим данным
    bad.send({ t: 'set_item', menuItemId: dish('Болоньезе').id, qty: 1 });
    await bad.waitError('not_joined');

    host.send({ t: 'close' });
    await host.waitState((s) => s.session.phase === 'closed', 'closed');
    for (const c of [host, again, retry, bad, guest]) c.ws.close();
  } finally {
    app.close();
  }
});

test('защита: чужой Origin, флуд, мусор', async () => {
  const { app, port, api } = await boot();
  try {
    // Браузер с другого сайта (Origin не совпадает с Host) не получает 101
    const status = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      s.once('data', (d) => { resolve(String(d).split('\r\n')[0]); s.destroy(); });
      s.on('close', () => resolve('closed'));
      s.on('error', () => resolve('error'));
    });
    assert.ok(!/101/.test(status), 'чужой Origin отклонён: ' + status);

    // Флуд: больше 40 сообщений за 5 секунд — соединение закрывают
    const f = client(port);
    await f.open;
    for (let i = 0; i < 60; i++) f.send({ t: 'ping' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(f.closed, 1008);

    // Кривой JSON и неизвестные команды не роняют сервер
    const g = client(port);
    await g.open;
    g.ws.send('{not json');
    g.send({ t: 'nope' });
    g.send({ t: 'set_item' });
    await g.waitError('bad_request');
    assert.strictEqual((await api('/api/sessions', { restaurantId: 999, hostName: 'x' })).status, 404);
    assert.strictEqual((await api('/api/sessions', { restaurantId: 1, hostName: '' })).status, 400);
    assert.strictEqual((await api('/api/sessions', { restaurantId: 1, hostName: 'x', limitRub: -1 })).status, 400);
    g.ws.close();

    // Имя с угловыми скобками хранится как текст; экранирование — на стороне клиента (textContent)
    const { host } = await hostOf(port, api, { hostName: '<b onclick=x>' });
    assert.strictEqual(host.state.me.name, '<b onclick=x>');
    assert.strictEqual((await api('/api/sessions', { restaurantId: 1, hostName: 'x'.repeat(25) })).status, 400);
    host.ws.close();
  } finally {
    app.close();
  }
});

test('реквизиты хоста, «Я перевёл», пометка для ресторана', async () => {
  const { app, port, api, dish } = await boot();
  try {
    const { host, code } = await hostOf(port, api, { payoutInfo: '+7 999 000-00-00, Т-Банк' });
    const guest = await guestOf(port, code, 'Аня');
    assert.strictEqual(guest.state.session.payout, '+7 999 000-00-00, Т-Банк');

    // Гость реквизиты не меняет; хост меняет, лишние пробелы убираются; слишком длинное не принимается
    guest.send({ t: 'set_payout', text: 'мои' });
    await guest.waitError('forbidden');
    host.send({ t: 'set_payout', text: '  +7 900 111-22-33,   Сбер  ' });
    await guest.waitState((s) => s.session.payout === '+7 900 111-22-33, Сбер', 'payout updated for guest');
    host.send({ t: 'set_payout', text: 'x'.repeat(121) });
    await host.waitError('bad_request');

    guest.send({ t: 'set_item', menuItemId: dish('Маргарита').id, qty: 1 });
    host.send({ t: 'set_item', menuItemId: dish('Карбонара').id, qty: 1 });
    await host.waitState((s) => s.session.total === 106000, 'both ordered');

    // До оплаты «Я перевёл» нажать нельзя
    guest.send({ t: 'claim_paid' });
    await guest.waitError('bad_state');

    host.send({ t: 'lock' });
    await host.waitState((s) => s.session.phase === 'locked', 'locked');
    assert.strictEqual(host.state.session.orderNote, null);
    host.send({ t: 'pay' });
    const paid = await host.waitState((s) => s.session.phase === 'paid', 'paid');
    assert.strictEqual(paid.session.orderNote, '[Совместный заказ · 2 чел.]');
    await guest.waitState((s) => s.session.phase === 'paid', 'guest paid');
    assert.strictEqual(guest.state.session.orderNote, '[Совместный заказ · 2 чел.]');
    assert.strictEqual(paid.settlement.find((r) => r.name === 'Аня').claimed, false);

    // Гость: «Я перевёл» → хост видит отметку и событие; подтверждает; может вернуть обратно
    guest.send({ t: 'claim_paid' });
    await host.waitState((s) => s.settlement.find((r) => r.name === 'Аня').claimed === true, 'claimed on host');
    await host.waitMsg('event');
    assert.ok(host.events.some((e) => e.kind === 'debt_claimed' && e.by === 'Аня'));
    assert.strictEqual(guest.state.settlement[0].claimed, true);
    assert.strictEqual(guest.state.settlement[0].status, 'owes', 'подтверждает только хост');

    host.send({ t: 'mark_debt', participantId: guest.state.me.id, status: 'paid' });
    await guest.waitState((s) => s.settlement[0].status === 'paid', 'confirmed');
    host.send({ t: 'mark_debt', participantId: guest.state.me.id, status: 'owes' });
    await guest.waitState((s) => s.settlement[0].status === 'owes' && s.settlement[0].claimed === false, 'reset');

    // Хост не может «перевести сам себе»; реквизиты можно поменять и после оплаты
    host.send({ t: 'claim_paid' });
    await host.waitError('not_found');
    host.send({ t: 'set_payout', text: '' });
    await guest.waitState((s) => s.session.payout === null, 'payout cleared');
    for (const c of [host, guest]) c.ws.close();
  } finally {
    app.close();
  }
});

test('/stats: итоги по оплаченным совместным заказам, защита ключом', async () => {
  const { app, port, api, dish, base } = await boot();
  const page = async (q = '') => {
    const r = await fetch(base + '/stats' + q);
    return { status: r.status, html: (await r.text()).replace(/\s/g, ' ') };
  };
  try {
    let r = await page();
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /Пока нет оплаченных совместных заказов/);
    assert.match(r.html, /noindex/);

    const { host, code } = await hostOf(port, api);
    const guest = await guestOf(port, code, 'Аня');
    guest.send({ t: 'set_item', menuItemId: dish('Маргарита').id, qty: 1 });
    host.send({ t: 'set_item', menuItemId: dish('Карбонара').id, qty: 1 });
    await host.waitState((s) => s.session.total === 106000, 'ordered');
    host.send({ t: 'lock' });
    await host.waitState((s) => s.session.phase === 'locked', 'locked');
    host.send({ t: 'pay' });
    await host.waitState((s) => s.session.phase === 'paid', 'paid');

    // 520 + 540 = 1060 ₽ блюд, доставка 199 ₽, сервис 5% = 53 ₽ → 1312 ₽ (один заказ, он же средний чек)
    r = await page();
    assert.ok(r.html.includes('<b>1</b>'), 'один заказ');
    assert.ok(r.html.includes('1 312 ₽'), 'выручка и средний чек: ' + r.html.slice(r.html.indexOf('tiles'), r.html.indexOf('tiles') + 400));
    assert.ok(r.html.includes('<b>2</b>'), 'двое в заказе');
    assert.ok(r.html.includes('<b>1</b>') && r.html.includes('Гостей пришло по ссылке'));
    assert.strictEqual(app.svc.stats().revenue, 131200);
    assert.strictEqual(app.svc.stats().avgCheck, 131200);

    // С ключом страница закрыта для всех, у кого его нет
    process.env.STATS_KEY = 'demo-key';
    assert.strictEqual((await page()).status, 404);
    assert.strictEqual((await page('?key=wrong')).status, 404);
    assert.strictEqual((await page('?key=demo-key')).status, 200);
    for (const c of [host, guest]) c.ws.close();
  } finally {
    delete process.env.STATS_KEY;
    app.close();
  }
});

test('миграция: база от старой версии получает новые колонки, данные целы', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-mig-'));
  const file = path.join(dir, 'old.db');
  try {
    // Схема «до обновления»: берём актуальную и вырезаем три новые колонки
    const old = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8')
      .replace(/,\n  payout_info[^\n]*\n  order_note[^\n]*/, '')
      .replace(/\n  claimed[^\n]*/, '');
    assert.ok(!/payout_info|order_note|claimed/.test(old.replace(/--[^\n]*/g, '')), 'тестовая схема действительно старая');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(old);
    raw.exec("INSERT INTO restaurants (id, name, delivery_fee, service_fee_pct) VALUES (1, 'Старый', 100, 0)");
    raw.exec(`INSERT INTO sessions (code, restaurant_id, title, delivery_fee, service_fee_pct, created_at, updated_at, expires_at)
              VALUES ('OLD123', 1, 'Старый заказ', 100, 0, 1, 1, 9999999999999)`);
    raw.close();

    const { openDb } = require('../lib/db');
    const db = openDb(file);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols('sessions').includes('payout_info') && cols('sessions').includes('order_note'));
    assert.ok(cols('settlements').includes('claimed'));
    assert.strictEqual(db.prepare("SELECT title FROM sessions WHERE code = 'OLD123'").get().title, 'Старый заказ');
    db.close();
    const again = openDb(file); // повторный запуск ничего не ломает
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/setup: подмена заведения и меню, ошибки формы, защита ADMIN_KEY, старый заказ не ломается', async () => {
  const { app, api, base, port } = await boot();
  try {
    const old = await hostOf(port, api);          // заказ на демо-меню
    const post = (fields) => fetch(base + '/setup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const ok = await post({ name: 'Суши Бар', deliveryRub: '149,50', servicePct: '10',
      menuText: 'Роллы | Филадельфия | 590 | Лосось, сыр | 8 шт.\nРоллы | Калифорния ! | 450\nНапитки | Чай | 120' });
    assert.strictEqual(ok.status, 200);
    const act = (await api('/api/active/menu')).body;
    assert.strictEqual(act.restaurant.name, 'Суши Бар');
    assert.strictEqual(act.restaurant.deliveryFee, 14950);
    assert.strictEqual(act.restaurant.servicePct, 10);
    assert.strictEqual(act.menu.length, 3);
    assert.strictEqual(act.menu[0].price, 59000);
    assert.strictEqual(act.menu[1].available, 0, '«!» = нет в наличии');
    // старое заведение и идущий заказ на месте
    assert.strictEqual((await api('/api/restaurants/1/menu')).body.menu.length, 16);
    old.host.send({ t: 'ping' }); assert.ok((await old.host.waitMsg('pong')) && old.host.state.session.restaurant.name.includes('Паста'), 'старый заказ жив');
    // форма предзаполнена текущим меню
    const page = await (await fetch(base + '/setup')).text();
    assert.ok(page.includes('Суши Бар') && page.includes('Филадельфия | 590'));
    // ошибки: строка без цены, пустое меню, XSS в названии экранируется
    assert.strictEqual((await post({ name: 'X', deliveryRub: '0', servicePct: '0', menuText: 'Роллы | Без цены' })).status, 400);
    assert.strictEqual((await post({ name: 'X', deliveryRub: '0', servicePct: '0', menuText: '\n' })).status, 400);
    assert.strictEqual((await post({ name: 'X', deliveryRub: '-5', servicePct: '0', menuText: 'a | b | 1' })).status, 400);
    await post({ name: '<img src=x onerror=alert(1)>', deliveryRub: '0', servicePct: '0', menuText: 'a | b | 1' });
    const html = await (await fetch(base + '/setup')).text();
    assert.ok(!html.includes('<img src=x'), 'название экранировано');
    // ключ
    process.env.ADMIN_KEY = 'k123';
    assert.strictEqual((await fetch(base + '/setup')).status, 404);
    assert.strictEqual((await fetch(base + '/setup?key=k123')).status, 200);
    assert.strictEqual((await post({ name: 'Y', deliveryRub: '0', servicePct: '0', menuText: 'a | b | 1' })).status, 404);
    assert.strictEqual((await post({ key: 'k123', name: 'Y', deliveryRub: '0', servicePct: '0', menuText: 'a | b | 1' })).status, 200);
  } finally {
    delete process.env.ADMIN_KEY;
    app.close();
  }
});

test('статика: ETag даёт 304, текст отдаётся в brotli или gzip, содержимое не меняется', async () => {
  const { app, base } = await boot();
  try {
    const plain = await fetch(base + '/app.js', { headers: { 'accept-encoding': 'identity' } });
    const raw = Buffer.from(await plain.arrayBuffer());
    const etag = plain.headers.get('etag');
    assert.ok(etag && !plain.headers.get('content-encoding'));
    const br = await fetch(base + '/app.js', { headers: { 'accept-encoding': 'br' } });
    assert.strictEqual(br.headers.get('content-encoding'), 'br');
    assert.ok(Number(br.headers.get('content-length')) < raw.length / 3, 'brotli заметно меньше');
    assert.strictEqual(Buffer.from(await br.arrayBuffer()).toString(), raw.toString(), 'после распаковки то же содержимое');
    const gz = await fetch(base + '/app.css', { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(gz.headers.get('content-encoding'), 'gzip');
    await gz.arrayBuffer();
    const again = await fetch(base + '/app.js', { headers: { 'if-none-match': etag } });
    assert.strictEqual(again.status, 304);
    assert.strictEqual((await again.arrayBuffer()).byteLength, 0);
    assert.strictEqual((await fetch(base + '/..%2f..%2fetc/passwd')).status === 200, false, 'выход из каталога закрыт');
  } finally { app.close(); }
});
