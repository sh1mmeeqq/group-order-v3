'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // встроенный SQLite, Node >= 22.5

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  migrate(db);
  seed(db);
  for (const r of db.prepare('SELECT id FROM restaurants WHERE key IS NULL').all()) {
    db.prepare('UPDATE restaurants SET key = ? WHERE id = ?').run(require('node:crypto').randomBytes(9).toString('base64url'), r.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rest_key ON restaurants(key)');
  if (file !== ':memory:') startPhoneCleanup(db);
  return db;
}

// 152-ФЗ: обезличивание телефонов участников через 24 ч после закрытия заказа.
// Затирается только поле телефона; строки участников, позиции и суммы остаются.
// Схему этот модуль не знает наверняка, поэтому таблицы/колонки определяются через PRAGMA;
// если подходящих нет — очистка тихо пропускается. ПДн и значения в логи не попадают.
const PHONE_TTL_MS = 24 * 60 * 60 * 1000;
const PHONE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function cols(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all(); } catch { return []; }
}

function anonymizePhones(db, now = Date.now()) {
  const sCols = cols(db, 'sessions');
  const sNames = sCols.map((c) => c.name);
  const closedCol = ['closed_at', 'closedAt'].find((n) => sNames.includes(n));
  if (!closedCol) return 0;
  const closedType = String(sCols.find((c) => c.name === closedCol).type || '').toUpperCase();
  if (closedType.includes('TEXT') || closedType.includes('CHAR')) return 0; // формат времени неизвестен — не рискуем
  const cutoff = now - PHONE_TTL_MS;
  let total = 0;
  for (const table of ['participants', 'members']) {
    const pCols = cols(db, table);
    const phone = pCols.find((c) => c.name === 'phone');
    if (!phone || !pCols.some((c) => c.name === 'session_id')) continue;
    const empty = phone.notnull ? "''" : 'NULL';
    // closed_at может быть в секундах или миллисекундах
    const res = db.prepare(
      `UPDATE ${table} SET phone = ${empty}
        WHERE phone IS NOT NULL AND phone <> ''
          AND session_id IN (
            SELECT id FROM sessions
             WHERE ${closedCol} IS NOT NULL AND ${closedCol} > 0
               AND (CASE WHEN ${closedCol} < 100000000000 THEN ${closedCol} * 1000 ELSE ${closedCol} END) <= ?)`
    ).run(cutoff);
    total += Number(res.changes) || 0;
  }
  return total;
}

function startPhoneCleanup(db) {
  const run = () => {
    try { anonymizePhones(db); } catch { /* без логирования: текст ошибки может содержать ПДн */ }
  };
  run();
  const timer = setInterval(run, PHONE_CLEANUP_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

// Файл БД мог быть создан старой версией: CREATE TABLE IF NOT EXISTS его не трогает,
// поэтому недостающие колонки добавляем отдельно (данные сохраняются).
function migrate(db) {
  const ensure = (table, column, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  ensure('sessions', 'payout_info', 'TEXT');
  ensure('sessions', 'order_note', 'TEXT');
  ensure('settlements', 'claimed', 'INTEGER NOT NULL DEFAULT 0');
  ensure('restaurants', 'key', 'TEXT');
  ensure('restaurants', 'origins', 'TEXT');       // сайты, где разрешён виджет: host через запятую
  ensure('restaurants', 'tg_chat', 'TEXT');
  ensure('restaurants', 'contacts', 'TEXT');          // каналы ресторана для кнопок «Заказ собран» (JSON: wa, tg, tel)
  ensure('restaurants', 'trial_until', 'INTEGER');   // конец пробного периода (мс), пусто = без ограничения       // чат Telegram, куда уходят заказы
  ensure('sessions', 'contact', 'TEXT');          // телефон и адрес из заказа (JSON)
}

// Демо-ресторан. Цены в копейках. «Четыре сыра» намеренно недоступна,
// чтобы можно было проверить состояние «нет в наличии» из ТЗ (раздел 5).
function seed(db) {
  if (db.prepare('SELECT COUNT(*) n FROM restaurants').get().n > 0) return;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO restaurants (id, name, delivery_fee, service_fee_pct) VALUES (1, ?, ?, ?)')
      .run('Паста & Бао (демо)', 19900, 5);
    const ins = db.prepare(
      'INSERT INTO menu_items (restaurant_id, category, name, description, weight, price, available, sort) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
    );
    const menu = [
      ['Закуски', 'Хумус с лепёшкой', 'Нутовая паста, оливковое масло, тёплая лепёшка', '220 г', 290, 1],
      ['Закуски', 'Цезарь с курицей', 'Романо, пармезан, соус цезарь, гренки', '250 г', 420, 1],
      ['Закуски', 'Крылья BBQ', '8 штук, соус барбекю, сельдерей', '320 г', 480, 1],
      ['Пицца', 'Маргарита', 'Томаты, моцарелла, базилик', '30 см', 520, 1],
      ['Пицца', 'Пепперони', 'Пепперони, моцарелла, томатный соус', '30 см', 640, 1],
      ['Пицца', 'Четыре сыра', 'Моцарелла, горгонзола, пармезан, чеддер', '30 см', 690, 0],
      ['Паста', 'Карбонара', 'Гуанчале, желток, пекорино', '300 г', 540, 1],
      ['Паста', 'Болоньезе', 'Говяжий рагу, томаты, пармезан', '300 г', 520, 1],
      ['Паста', 'Паста с креветками', 'Тигровые креветки, чеснок, сливки', '310 г', 760, 1],
      ['Бао', 'Бао со свининой', 'Томлёная свинина, пикули, кинза', '2 шт.', 330, 1],
      ['Бао', 'Бао с тофу', 'Хрустящий тофу, кимчи, кунжут', '2 шт.', 290, 1],
      ['Напитки', 'Лимонад домашний', 'Лимон, мята', '0,4 л', 250, 1],
      ['Напитки', 'Морс клюквенный', 'Клюква, мёд', '0,4 л', 220, 1],
      ['Напитки', 'Кола', 'Классическая', '0,33 л', 150, 1],
      ['Десерты', 'Тирамису', 'Маскарпоне, савоярди, кофе', '140 г', 350, 1],
      ['Десерты', 'Чизкейк', 'Нью-йоркский, ягодный соус', '130 г', 380, 1],
    ];
    menu.forEach(([cat, name, desc, weight, rub, avail], i) =>
      ins.run(cat, name, desc, weight, rub * 100, avail, i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, anonymizePhones };

