'use strict';
// Воронка и KPI из бизнес-плана, посчитанные по журналу событий.
// Запуск: node --disable-warning=ExperimentalWarning scripts/metrics.js [путь к БД]   (по умолчанию data/group-order.db)
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function funnel(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  const sessions = (type) => one('SELECT COUNT(DISTINCT session_id) n FROM events WHERE type = ?', type);
  const people = (type) => one('SELECT COUNT(DISTINCT participant_id) n FROM events WHERE type = ?', type);
  const count = (type) => one('SELECT COUNT(*) n FROM events WHERE type = ?', type);

  const created = sessions('group_order_created');
  const opened = count('guest_link_opened');
  const named = people('guest_name_entered');
  const withItem = people('guest_first_item_added');
  const paid = sessions('group_order_paid');
  const withLimit = one("SELECT COUNT(*) n FROM events WHERE type = 'group_order_created' AND payload LIKE '%\"limit\":true%'");
  const withTimer = one("SELECT COUNT(*) n FROM events WHERE type = 'group_order_created' AND payload LIKE '%\"timer\":true%'");

  const durations = db.prepare(
    `SELECT p.ts - c.ts AS d FROM events c JOIN events p ON p.session_id = c.session_id
      WHERE c.type = 'group_order_created' AND p.type = 'group_order_paid' ORDER BY d`).all().map((r) => r.d);
  const medianMin = durations.length ? Math.round((durations[Math.floor(durations.length / 2)] / 60000) * 10) / 10 : null;

  return {
    sessionsCreated: created,
    guestLinkOpens: opened,
    guestsNamed: named,
    guestsWithItem: withItem,
    sessionsPaid: paid,
    avgGuestsPerSession: created ? Math.round((named / created) * 10) / 10 : null, // ориентир: 3+
    openedToNamedPct: pct(named, opened), // ориентир: > 80%
    namedToItemPct: pct(withItem, named), // ориентир: > 70%
    createdToPaidPct: pct(paid, created), // ориентир: > 55%
    medianCreateToPayMin: medianMin, // ориентир: < 12 мин
    limitUsedPct: pct(withLimit, created),
    timerUsedPct: pct(withTimer, created),
    limitHits: count('guest_limit_hit'),
    timerExpired: sessions('timer_expired'),
    invitesShared: count('invite_shared'),
    debtsMarkedPaid: count('debt_marked_paid'),
    guestAppInstallTaps: count('guest_app_install_tap'),
  };
}

module.exports = { funnel };

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'data', 'group-order.db');
  console.table(funnel(new DatabaseSync(file, { readOnly: true })));
}
