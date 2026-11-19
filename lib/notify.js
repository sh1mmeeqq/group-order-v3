'use strict';
// Доставка заказов ресторану в Telegram. Заказ лежит в таблице outbox и уходит с повторами,
// поэтому сбой сети или Telegram не теряет заказ. Токен бота только на сервере (TG_BOT_TOKEN).
// Привязка чата: ресторан пишет боту «/start КЛЮЧ» (ключ показывает /setup).
// TG_API_BASE можно заменить на прокси, если api.telegram.org недоступен с хостинга.

const BACKOFF = [10e3, 60e3, 10 * 60e3, 30 * 60e3, 60 * 60e3]; // после 6-й неудачи заказ помечается failed

class Notifier {
  constructor(svc, { token = process.env.TG_BOT_TOKEN, base = process.env.TG_API_BASE || 'https://api.telegram.org', fetchFn = fetch } = {}) {
    this.svc = svc;
    this.token = token;
    this.base = base;
    this.fetch = fetchFn;
    this.offset = 0;
    this.timer = null;
    this.stopped = false;
  }

  async api(method, body, signal) {
    const res = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`telegram ${res.status}: ${data.description || 'error'}`);
    return data.result;
  }

  // Отправляет всё, что пора отправить. Возвращает число доставленных.
  async flush() {
    if (!this.token) return 0;
    const now = this.svc.now();
    const rows = this.svc.all("SELECT * FROM outbox WHERE status = 'new' AND next_at <= ? ORDER BY id LIMIT 20", now);
    let sent = 0;
    for (const r of rows) {
      try {
        await this.api('sendMessage', { chat_id: r.chat, text: r.text });
        this.svc.run("UPDATE outbox SET status = 'sent', attempts = attempts + 1, error = NULL WHERE id = ?", r.id);
        sent++;
      } catch (e) {
        const n = r.attempts + 1;
        const fail = n > BACKOFF.length;
        this.svc.run('UPDATE outbox SET status = ?, attempts = ?, next_at = ?, error = ? WHERE id = ?',
          fail ? 'failed' : 'new', n, now + BACKOFF[Math.min(n - 1, BACKOFF.length - 1)], String(e.message).slice(0, 200), r.id);
        console.error('[notify] order', r.id, 'attempt', n, e.message);
      }
    }
    return sent;
  }

  // Один цикл long polling: ищем «/start КЛЮЧ» и привязываем чат.
  async poll() {
    if (!this.token) return;
    const updates = await this.api('getUpdates', { offset: this.offset, timeout: 20, allowed_updates: ['message'] });
    for (const u of updates) {
      this.offset = u.update_id + 1;
      const m = u.message;
      const match = m && typeof m.text === 'string' && /^\/start(?:@\w+)?\s+([\w-]{6,32})\s*$/.exec(m.text);
      if (!match) continue;
      const rest = this.svc.restaurantByKey(match[1]);
      const reply = rest ? this.link(rest.id, m.chat.id, rest.name) : 'Ключ не подошёл. Проверьте его на странице настройки.';
      await this.api('sendMessage', { chat_id: m.chat.id, text: reply }).catch(() => {});
    }
  }

  link(restaurantId, chatId, name) {
    this.svc.run('UPDATE restaurants SET tg_chat = ? WHERE id = ?', String(chatId), restaurantId);
    return `Готово: заказы «${name}» будут приходить сюда.`;
  }

  start() {
    if (!this.token) { console.log('[notify] TG_BOT_TOKEN не задан: заказы не отправляются'); return; }
    const loop = async (fn, pause) => {
      while (!this.stopped) {
        try { await fn(); } catch (e) { console.error('[notify]', e.message); await new Promise((r) => setTimeout(r, 5000)); }
        await new Promise((r) => { this.timer = setTimeout(r, pause); this.timer.unref?.(); });
      }
    };
    loop(() => this.flush(), 3000);
    loop(() => this.poll(), 200);
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

module.exports = { Notifier };
