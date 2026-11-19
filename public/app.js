'use strict';
// Клиент группового заказа: один код для хоста и гостя. Роль определяет сервер (state.me.isHost).
// Экраны названы по ТЗ: H1–H7 (хост), G1–G8 (гость).
(function () {
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  const $toasts = document.getElementById('toasts');
  const $live = document.getElementById('live');
  const $net = document.getElementById('net');

  // ---------- Утилиты ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rub = (kop) => {
    const v = kop / 100;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v) + ' ₽';
  };
  const plural = (n, a, b, c) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return a;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
    return c;
  };
  const clockText = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const svgi = (d) => `<svg class="ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    users: svgi('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M17 14.2c2.4.2 4 2.1 4 4.8"/>'),
    clock: svgi('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    qr: svgi('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 20h3v-3"/>'),
    gear: svgi('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    lock: svgi('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    check: svgi('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    alert: svgi('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
  };

  const ERR = {
    session_locked: 'Корзина заблокирована',
    time_up: 'Время выбора вышло',
    item_unavailable: 'Этого блюда нет в наличии',
    cart_full: 'Достигнут предел сессии',
    forbidden: 'Это действие недоступно',
    cart_empty: 'Корзина пуста',
    bad_state: 'Состояние заказа изменилось, попробуйте ещё раз',
    session_closed: 'Заказ уже закрыт',
    trial_over: 'Пробный период закончился. Обратитесь в ресторан.',
    not_found: 'Не найдено',
    bad_request: 'Проверьте введённые данные',
    payment_failed: 'Оплата не прошла. Корзина осталась заблокированной',
    internal: 'Что-то пошло не так. Попробуйте ещё раз',
  };
  const CLOSE_TEXT = {
    cancelled: 'Хост отменил групповой заказ',
    expired: 'Время сессии истекло',
    completed: 'Этот групповой заказ завершён',
  };

  // ---------- Одиночная корзина ----------
  // Пока заказ не стал групповым, выбранные блюда лежат в localStorage: { menuItemId: qty }.
  const loadSolo = () => { try { return JSON.parse(store.get('go:solo') || '{}') || {}; } catch { return {}; } };
  const saveSolo = () => store.set('go:solo', JSON.stringify(S.solo));

  // ---------- Состояние ----------
  const path = location.pathname;
  const S = {
    role: path.startsWith('/j/') ? 'guest' : 'host',
    code: (path.split('/')[2] || '').toUpperCase() || null,
    token: null, ws: null, connected: false, retry: 0,
    menu: null, restaurant: null, st: null, anon: null, fatal: null,
    view: 'menu', tab: 'mine', cat: null, offset: 0,
    fresh: new Map(), draftName: '', sheet: null, warned: null, showInvite: false, trackedPaid: false,
    solo: loadSolo(), transfer: null, consent: false,
  };
  if (S.code) S.token = store.get('go:token:' + S.code);

  // Во фрейме на сайте ресторана ссылка для друзей ведёт на сам сайт (?go=КОД), а не на наш домен.
  const qs = new URLSearchParams(location.search);
  const siteUrl = () => {
    try {
      const u = new URL(qs.get('s') || '');
      const ok = (S.st && S.st.session.origins || []).includes(u.host.toLowerCase());
      return ok && u.protocol.startsWith('http') ? u.origin + u.pathname : null;
    } catch { return null; }
  };
  const inviteUrl = () => { const site = siteUrl(); return site ? `${site}?go=${S.code}` : `${location.origin}/j/${S.code}`; };
  const soloItems = () => (S.menu || []).filter((m) => m.available && S.solo[m.id] > 0).map((m) => ({ ...m, qty: S.solo[m.id] }));
  const soloUnits = () => soloItems().reduce((a, m) => a + m.qty, 0);
  const soloTotal = () => soloItems().reduce((a, m) => a + m.qty * m.price, 0);
  const dishWord = (n) => plural(n, 'блюдо', 'блюда', 'блюд');
  const me = () => S.st && S.st.me;

  // ---------- Сеть ----------
  function connect() {
    clearTimeout(S.rt);
    if (S.ws && S.ws.readyState <= 1) { // уже подключены/подключаемся
      return;
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    // Если рукопожатие «зависло» за прокси — рвём и переподключаемся.
    const hang = setTimeout(() => { if (ws.readyState === 0) ws.close(); }, 8000);
    ws.onerror = () => { /* onclose выполнит переподключение */ };
    ws.onopen = () => {
      clearTimeout(hang);
      S.retry = 0;
      setNet(true);
      ws.send(JSON.stringify({ t: 'hello', code: S.code, token: S.token }));
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      clearTimeout(hang);
      if (S.ws !== ws) return;
      setNet(false);
      if (!S.fatal) S.rt = setTimeout(connect, Math.min(10000, 1000 * 2 ** S.retry++) + Math.random() * 500);
    };
  }

  // Быстрый реконнект при возврате на вкладку / появлении сети.
  const wake = () => {
    if (S.fatal || !S.code) return;
    if (S.ws && S.ws.readyState <= 1) return;
    S.retry = 0;
    connect();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  function setNet(ok) {
    S.connected = ok;
    $net.hidden = ok;
    if (S.st) render();
  }

  function send(msg) {
    if (!S.ws || S.ws.readyState !== 1) { toast('Нет связи. Пробуем подключиться…'); return false; }
    S.ws.send(JSON.stringify(msg));
    return true;
  }

  function onMsg(msg) {
    switch (msg.t) {
      case 'anon':
        if (S.role === 'host') { S.fatal = 'host_no_access'; S.ws.close(); return render(); }
        S.anon = msg.preview;
        if (!S.draftName) S.draftName = store.get('go:name') || '';
        return render();
      case 'welcome':
        S.menu = msg.menu;
        S.restaurant = msg.restaurant;
        if (msg.token) { S.token = msg.token; store.set('go:token:' + S.code, msg.token); }
        return;
      case 'state': return onState(msg);
      case 'event': return onEvent(msg);
      case 'kicked': S.fatal = 'kicked'; if (S.ws) S.ws.close(); return render();
      case 'error': return onError(msg);
      default: return undefined;
    }
  }

  function onState(next) {
    const prev = S.st;
    S.offset = next.now - Date.now();
    if (prev) {
      const old = new Map();
      for (const p of prev.participants) for (const it of p.items) old.set(`${p.id}:${it.menuItemId}`, it.qty);
      for (const p of next.participants) {
        if (p.id === next.me.id) continue;
        for (const it of p.items) {
          const k = `${p.id}:${it.menuItemId}`;
          if (old.get(k) !== it.qty) S.fresh.set(k, Date.now());
        }
      }
    }
    if (prev && prev.session.phase !== next.session.phase && !['waiting', 'selecting'].includes(next.session.phase)) closeSheet();
    if (next.session.phase === 'paid' && !next.me.isHost) store.set('go:name', next.me.name);
    S.st = next;
    S.anon = null;
    if (S.transfer && next.me.isHost) { const list = S.transfer; S.transfer = null; transferSolo(list); }
    if (S.showInvite && next.me.isHost) { S.showInvite = false; render(); openInvite(); return; }
    render();
  }

  function onEvent(ev) {
    const text = eventText(ev);
    if (!text) return;
    live(text);
    if (me() && me().isHost && ['guest_joined', 'item_added', 'item_changed', 'item_removed', 'debt_claimed'].includes(ev.kind)) toast(text);
    if (me() && !me().isHost && ['timer_extended', 'settings_changed'].includes(ev.kind)) toast(text);
  }

  function eventText(ev) {
    const who = ev.forName ? `${ev.by} → ${ev.forName}` : ev.by;
    switch (ev.kind) {
      case 'guest_joined': return `${ev.by} присоединился к заказу`;
      case 'item_added': return `${who}: добавлено «${ev.item}»`;
      case 'item_changed': return `${who}: «${ev.item}» × ${ev.qty}`;
      case 'item_removed': return `${who}: убрано «${ev.item}»`;
      case 'guest_done': return `${ev.by} закончил выбор`;
      case 'debt_claimed': return `${ev.by} отметил, что перевёл свою часть`;
      case 'timer_extended': return `Хост продлил время на ${ev.minutes} мин`;
      case 'settings_changed': return 'Хост изменил настройки заказа';
      case 'locked': return 'Хост заблокировал корзину';
      case 'unlocked': return 'Корзина снова открыта';
      default: return '';
    }
  }

  function onError(msg) {
    const c = msg.code;
    if (c === 'session_not_found' || c === 'session_finished') {
      S.fatal = c;
      if (S.ws) S.ws.close();
      return render();
    }
    if (c === 'limit_exceeded') return openLimit(msg);
    if (!S.st && S.anon) {
      const el = document.getElementById('nerr');
      if (el) el.textContent = c === 'session_full' ? 'В этом заказе уже максимум гостей' : 'Введите имя, не длиннее 24 символов';
      return undefined;
    }
    return toast(ERR[c] || ERR.internal);
  }

  // ---------- Тосты и озвучивание ----------
  // Уведомления висят сверху: под шапкой и под строкой «гости · таймер · сумма», чтобы не закрывать итог.
  // Нижние кнопки и список блюд они не трогают, а тапы пропускают (pointer-events: none).
  const TOAST_MS = 2500;
  function toast(text) {
    const anchor = document.querySelector('.strip') || document.querySelector('.top');
    const below = anchor ? anchor.getBoundingClientRect().bottom : 0; // якорь ушёл вверх при прокрутке → отступ от края экрана
    $toasts.style.top = `calc(env(safe-area-inset-top, 0px) + ${Math.max(0, Math.round(below)) + 8}px)`;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $toasts.appendChild(el);
    while ($toasts.children.length > 2) $toasts.firstChild.remove();
    setTimeout(() => el.classList.add('out'), TOAST_MS - 250);
    setTimeout(() => el.remove(), TOAST_MS);
  }
  let liveLast = 0, livePending = [], liveTimer = null;
  function live(text) { // не чаще раза в 3 секунды, накопленное склеивается
    livePending.push(text);
    const flush = () => { $live.textContent = livePending.join('. '); livePending = []; liveLast = Date.now(); liveTimer = null; };
    const wait = 3000 - (Date.now() - liveLast);
    if (wait <= 0) flush();
    else if (!liveTimer) liveTimer = setTimeout(flush, wait);
  }

  // ---------- Шторки ----------
  let lastFocus = null;
  function openSheet(kind, label, html) {
    lastFocus = document.activeElement;
    S.sheet = kind;
    $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
        <button class="x" data-act="close-sheet" aria-label="Закрыть">×</button>${html}</div>`;
    document.body.classList.add('noscroll');
    const first = $sheet.querySelector('input:not([type=checkbox]), .btn.primary');
    if (first) first.focus({ preventScroll: true }); // иначе длинная шторка открывается прокрученной к нижней кнопке
  }
  function closeSheet() {
    if (!S.sheet) return;
    S.sheet = null;
    $sheet.innerHTML = '';
    document.body.classList.remove('noscroll');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- Рендер: общие куски ----------
  const avatar = (p) => `<span class="av" style="background:hsl(${(p.id * 47) % 360} 45% 36%)" aria-hidden="true">${esc([...p.name][0].toUpperCase())}</span>`;
  const mySubtotal = () => { const m = S.st.participants.find((p) => p.id === S.st.me.id); return m ? m.subtotal : 0; };
  const myQty = (mid) => {
    const m = S.st.participants.find((p) => p.id === S.st.me.id);
    const it = m && m.items.find((i) => i.menuItemId === mid);
    return it ? it.qty : 0;
  };

  function stepper(mid, qty, pid, can) {
    const off = can ? '' : ' off" aria-disabled="true';
    return `<div class="step" role="group" aria-label="Количество">
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty - 1}" data-pid="${pid || ''}" aria-label="Убрать одну порцию">−</button>
      <span class="sq">${qty}</span>
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty + 1}" data-pid="${pid || ''}" aria-label="Добавить порцию">+</button></div>`;
  }

  // Счётчик одиночной корзины: те же кнопки, но действие меняет локальную корзину, а не комнату
  const soloStepper = (mid, qty) => `<div class="step" role="group" aria-label="Количество">
      <button class="sb" data-act="solo-set" data-mid="${mid}" data-qty="${qty - 1}" aria-label="Убрать одну порцию">−</button>
      <span class="sq">${qty}</span>
      <button class="sb" data-act="solo-set" data-mid="${mid}" data-qty="${qty + 1}" aria-label="Добавить порцию">+</button></div>`;

  function dishHtml(m, mode) { // mode: { solo } — одиночная корзина, { can } — комната
    const act = !m.available ? '<span class="tag bad">Нет в наличии</span>'
      : mode && mode.solo ? (S.solo[m.id] > 0 ? soloStepper(m.id, S.solo[m.id])
        : `<button class="btn small primary add-solo" data-act="solo-set" data-mid="${m.id}" data-qty="1" aria-label="В корзину: ${esc(m.name)}">+ В корзину</button>`)
      : !mode ? ''
      : myQty(m.id) > 0 ? stepper(m.id, myQty(m.id), '', mode.can)
        : `<button class="sb add${mode.can ? '' : ' off" aria-disabled="true'}" data-act="qty" data-mid="${m.id}" data-qty="1" aria-label="Добавить: ${esc(m.name)}">+</button>`;
    return `<article class="dish${m.available ? '' : ' na'}">
      <div class="dish-main"><h3>${esc(m.name)}</h3>${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
        <p class="meta"><b>${rub(m.price)}</b>${m.weight ? ` · ${esc(m.weight)}` : ''}</p></div>${act}</article>`;
  }

  function menuListHtml(mode) {
    const cats = [...new Set(S.menu.map((m) => m.category))];
    const list = S.cat ? S.menu.filter((m) => m.category === S.cat) : S.menu;
    return `<div class="cats" role="group" aria-label="Категории">
        <button aria-pressed="${!S.cat}" data-act="cat" data-v="">Все</button>
        ${cats.map((c) => `<button aria-pressed="${S.cat === c}" data-act="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <main>${list.map((m) => dishHtml(m, mode)).join('')}</main>`;
  }

  // ---------- Подсказки (?) и тексты форм ----------
  const TXT = {
    payoutLabel: 'Куда друзьям перевести свою часть?',
    payoutPh: '+7 900 123-45-67, Т-Банк',
    createBtn: 'Позвать друзей по ссылке',
  };
  // Согласие на обработку ПДн (152-ФЗ): по умолчанию не отмечено, без отметки форма не отправляется
  const CONSENT_ERR = 'Отметьте согласие на обработку персональных данных';
  const consentHtml = (id, checked) => `<label class="consent" style="display:flex;gap:8px;align-items:flex-start;margin:12px 0 4px;font-size:13px;text-align:left">
      <input type="checkbox" id="${id}" data-consent style="flex:none;margin-top:2px"${checked ? ' checked' : ''}>
      <span>Я согласен(на) на обработку персональных данных (<a href="/privacy" target="_blank" rel="noopener">Политика</a>) и принимаю <a href="/offer" target="_blank" rel="noopener">оферту</a></span></label>`;
  const consentOk = (id) => { const c = document.getElementById(id); return !!(c && c.checked); };
  const HELP = {
    name: 'Так вас увидят друзья в общей корзине. Достаточно имени, регистрация не нужна.',
    title: 'Короткое название, чтобы друзья сразу поняли, о чём заказ. Можно оставить пустым.',
    limit: 'Сколько один человек может заказать, чтобы счёт не вышел из-под контроля. Например, 1 500 ₽. Блюда сверх лимита добавить не получится.',
    timer: 'Через сколько минут выбор закроется для всех. Хост может продлить время одним нажатием.',
    payout: 'Номер телефона и банк, куда вам удобно получать переводы по СБП. Друзья увидят их вместе со своей суммой после оплаты. Можно добавить позже.',
  };
  const helpBtn = (id) => `<button type="button" class="help" data-act="help" data-for="${id}" aria-expanded="false" aria-controls="${id}" aria-label="Подсказка">?</button>`;
  const helpPop = (id, text) => `<p class="help-pop" id="${id}" hidden>${text}</p>`;
  // Подпись поля + кнопка (?) рядом; сама подсказка раскрывается под подписью
  const fieldLabel = (forId, text, helpKey, opt) => `<div class="lab"><label class="f" for="${forId}">${text}${opt ? ' <span class="muted">(по желанию)</span>' : ''}</label>${helpBtn('h-' + helpKey)}</div>${helpPop('h-' + helpKey, HELP[helpKey])}`;
  const toggleRow = (id, text, helpKey, checked) => `<div class="lab rowh"><label class="row"><span>${text}</span><input type="checkbox" id="${id}" role="switch" ${checked ? 'checked' : ''}></label>${helpBtn('h-' + helpKey)}</div>${helpPop('h-' + helpKey, HELP[helpKey])}`;

  // ---------- Онбординг и «О совместном заказе» ----------
  const STEPS = [
    ['Создайте ссылку', 'Назовите заказ и отправьте ссылку друзьям в мессенджер. Можно показать QR-код.'],
    ['Друзья выбирают блюда сами', 'Они открывают ссылку на телефоне, вводят имя и добавляют блюда. Вы видите общую корзину в реальном времени.'],
    ['Оплатите и разделите', 'Вы оформляете один заказ, а мы считаем, сколько с кого. Каждый друг видит свою часть и ваши реквизиты для перевода.'],
  ];
  const stepsHtml = () => `<ol class="steps">${STEPS.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join('')}</ol>`;

  function openOnboarding() {
    openSheet('onboarding', 'Как работает совместный заказ', `<h2>Закажите вместе, платите каждый за своё</h2>
      <p class="muted" style="margin-bottom:12px">Один общий заказ на всю компанию. Друзьям ничего устанавливать не нужно.</p>
      ${stepsHtml()}
      <div class="acts"><button class="btn primary" data-act="onb-go">Понятно, создать ссылку</button>
        <button class="btn" data-act="close-sheet">Позже</button></div>
      <p class="hint">Этот экран показывается один раз. Он всегда доступен по кнопке «?» рядом с «Заказать компанией».</p>`);
  }

  function openAbout() {
    openSheet('about', 'О совместном заказе', `<h2>О совместном заказе</h2>
      <section class="about"><h3>Что это</h3>
        <p>Общая корзина для компании. Каждый выбирает блюда со своего телефона, а один человек (хост) оформляет и оплачивает заказ.</p></section>
      <section class="about"><h3>Как это работает</h3>${stepsHtml()}</section>
      <section class="about"><h3>Что можно настроить</h3>
        <dl class="defs">
          <div><dt>Лимит на гостя</dt><dd>Максимум, на сколько один человек может заказать. Например, 1 500 ₽.</dd></div>
          <div><dt>Таймер выбора</dt><dd>Время, через которое выбор закроется. Например, 15 минут. Хост может продлить.</dd></div>
          <div><dt>Куда перевести</dt><dd>Телефон и банк для СБП, чтобы друзья быстро отправили свою часть.</dd></div>
        </dl></section>
      <section class="about"><h3>Как заполнять поля</h3>
        <dl class="defs ex">
          <div><dt>Имя</dt><dd>Аня</dd></div>
          <div><dt>Название заказа</dt><dd>Обед в офисе · День рождения Макса</dd></div>
          <div><dt>Куда перевести</dt><dd>+7 900 123-45-67, Т-Банк<br>Сбер, +7 900 123-45-67, Иван П.</dd></div>
        </dl></section>
      <section class="about"><h3>Пример расчёта</h3>
        <pre class="receipt" aria-label="Пример расчёта: Аня 650 рублей, Макс 420 рублей, вы 800 рублей">Обед в офисе · 3 человека
Аня .......... 650 ₽
Макс ......... 420 ₽
Вы ........... 800 ₽</pre>
        <p class="muted">Доставка и сервисный сбор делятся между всеми пропорционально заказам. Вы видите, кто уже перевёл, и подтверждаете получение.</p></section>
      <section class="about"><h3>Частые вопросы</h3>
        <dl class="defs">
          <div><dt>Друзьям нужно что-то устанавливать?</dt><dd>Нет. Ссылка открывается в браузере, регистрация не нужна.</dd></div>
          <div><dt>Деньги идут через приложение?</dt><dd>Нет. Друзья переводят свою часть вам напрямую по СБП, а вы отмечаете, кто уже перевёл.</dd></div>
          <div><dt>Кто-то передумал?</dt><dd>Пока корзина не оплачена, хост может разблокировать её, и друзья смогут изменить выбор.</dd></div>
        </dl></section>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Понятно</button></div>`);
  }

  // ---------- H1: меню с кнопкой «Заказать компанией» ----------
  function hostHomeHtml() {
    if (!S.menu) return '<p class="boot">Загрузка меню…</p>';
    const tip = store.get('go:tip') ? '' : '<div class="tip" role="note">Закажите вместе: друзья выберут блюда сами<button data-act="tip-close">Понятно</button></div>';
    return `<header class="top"><div class="top-t"><div class="rest">Меню ресторана</div><h1>${esc(S.restaurant.name)}</h1></div>
        <div class="top-a"><button class="btn small outline" data-act="create-open">${ICON.users} Заказать компанией</button>
          <button class="about-btn" data-act="about-open" aria-label="Как работает совместный заказ">?</button></div></header>
      ${tip}
      ${menuListHtml({ solo: true })}${soloBarHtml()}`;
  }

  // Плавающая плашка «Моя корзина (N блюд · сумма)»: видна, пока в одиночной корзине что-то есть
  function soloBarHtml() {
    const n = soloUnits();
    if (!n) return '';
    return `<footer class="bar"><div class="bar-in"><button class="btn primary" data-act="solo-open">Моя корзина (${n} ${dishWord(n)} · ${rub(soloTotal())})</button></div></footer>`;
  }

  // ---------- G1: вход по ссылке, ввод имени ----------
  function nameHtml() {
    const a = S.anon;
    return `<section class="hero">
      <p class="eyebrow">${esc(a.restaurant)}</p>
      <h1>${esc(a.hostName)} зовёт вас заказать вместе</h1>
      <form data-form="join" novalidate>
        <label class="f" for="nm">Как вас зовут?</label>
        <input id="nm" type="text" maxlength="24" autocomplete="given-name" autocapitalize="words" placeholder="Например, Макс" value="${esc(S.draftName)}" required>
        ${consentHtml('c-join', S.consent)}
        <p class="err" id="nerr" role="alert"></p>
        <button class="btn primary wide" type="submit">Продолжить</button>
        <p class="hint">Регистрация и установка не нужны: просто введите имя и выбирайте блюда</p>
      </form></section>`;
  }

  // ---------- Итоговые экраны ----------
  function fatalHtml() {
    const map = {
      kicked: ['Вас исключили из заказа', 'Хост убрал вас из этого группового заказа.'],
      host_no_access: ['Заказ создан на другом устройстве', 'Откройте заказ там, где вы его создали. Друзья могут присоединиться по ссылке.'],
      session_not_found: ['Заказ не найден', 'Проверьте ссылку: возможно, она набрана с ошибкой.'],
    };
    const [title, text] = map[S.fatal] || ['Этот групповой заказ завершён', 'Ссылка устарела или заказ уже закрыт.'];
    return closedBlock(title, text);
  }
  function closedBlock(title, text) {
    return `<section class="hero"><p class="eyebrow">Групповой заказ</p><h1>${esc(title)}</h1>
      <p class="muted" style="margin-bottom:24px">${esc(text)}</p>
      <a class="btn primary wide" style="text-decoration:none" href="/host">Открыть ресторан</a></section>`;
  }

  // ---------- Сессия ----------
  function sessionHtml() {
    const { session: ss, me: m } = S.st;
    if (ss.phase === 'closed') return closedBlock(CLOSE_TEXT[ss.closeReason] || CLOSE_TEXT.completed, 'Можно оформить новый заказ в ресторане.');
    if (ss.phase === 'paid') return m.isHost ? hostPaidHtml() : guestPaidHtml();
    const units = m.isHost ? ss.units : (S.st.participants.find((p) => p.id === m.id) || { items: [] }).items.reduce((a, i) => a + i.qty, 0);
    return `${topHtml()}${stripHtml()}${bannerHtml()}
      <nav class="seg" role="tablist" aria-label="Раздел">
        <button role="tab" aria-selected="${S.view === 'menu'}" data-act="view" data-v="menu">Меню</button>
        <button role="tab" aria-selected="${S.view === 'cart'}" data-act="view" data-v="cart">Корзина${units ? ` · ${units}` : ''}</button></nav>
      ${S.view === 'cart' ? cartHtml() : menuListHtml({ can: m.canEdit && S.connected })}
      ${barHtml()}`;
  }

  function topHtml() {
    const { session: ss, me: m } = S.st;
    const tools = m.isHost
      ? `<div class="top-a"><button class="ib" data-act="invite" aria-label="Пригласить: QR-код и ссылка">${ICON.qr}</button>
         <button class="ib" data-act="settings" aria-label="Настройки заказа">${ICON.gear}</button></div>` : '';
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div>${tools}</header>`;
  }

  function remaining() { return S.st.session.deadlineAt - (Date.now() + S.offset); }

  function stripHtml() {
    const { session: ss, me: m } = S.st;
    const chips = [`<span class="chip">${ICON.users} ${ss.guestCount} ${plural(ss.guestCount, 'гость', 'гостя', 'гостей')}</span>`];
    if (ss.deadlineAt) {
      const up = ss.phase === 'time_up';
      chips.push(`<span class="chip${up ? ' warn' : ''}" data-timer>${ICON.clock}<span>${up ? '00:00' : clockText(remaining())}</span></span>`);
    }
    chips.push(`<span class="chip strong">${rub(ss.total)}</span>`);
    let meter = '';
    if (!m.isHost && ss.limit) {
      const sub = mySubtotal();
      const left = Math.max(0, ss.limit - sub);
      const ratio = Math.min(1, sub / ss.limit);
      chips.push(`<span class="chip${ratio >= 0.8 ? ' warn' : ''}">Лимит: осталось ${rub(left)}</span>`);
      meter = `<div class="meter${ratio >= 0.8 ? ' warn' : ''}" role="progressbar" aria-label="Использовано из лимита" aria-valuemin="0" aria-valuemax="${ss.limit}" aria-valuenow="${Math.min(sub, ss.limit)}"><i style="width:${Math.round(ratio * 100)}%"></i></div>`;
    }
    return `<div class="strip">${chips.join('')}</div>${meter}`;
  }

  function bannerHtml() {
    const { session: ss, me: m } = S.st;
    const out = [];
    if (ss.phase === 'time_up') {
      out.push(`<div class="banner warn" role="status">${ICON.clock}<div><b>Время выбора вышло</b><span>${m.isHost ? 'Гости больше не могут добавлять блюда.' : 'Меню в режиме просмотра, пока хост не продлит время.'}</span></div>
        ${m.isHost ? '<button class="btn small" data-act="extend" data-min="5">+5 мин</button>' : ''}</div>`);
    }
    if (ss.phase === 'locked') {
      out.push(`<div class="banner lock" role="status">${ICON.lock}<div><b>${m.isHost ? 'Корзина заблокирована' : 'Хост оформляет заказ'}</b><span>${m.isHost ? 'Гости видят это и не могут менять заказ.' : 'Изменения закрыты.'}</span></div></div>`);
    }
    if (m.isHost && ss.unavailable > 0 && ss.phase !== 'locked') {
      out.push(`<div class="banner warn" role="status">${ICON.alert}<div><b>Есть недоступные блюда: ${ss.unavailable}</b><span>Замените их до оплаты.</span></div></div>`);
    }
    return out.join('');
  }

  function groupHtml(p, opts) {
    const { session: ss, me: m } = S.st;
    const mine = p.id === m.id;
    const can = m.canEdit && S.connected && (m.isHost || mine);
    const showCtl = (m.isHost || mine);
    const over = ss.limit && !p.isHost && p.subtotal > ss.limit;
    const left = ss.limit && !p.isHost ? ss.limit - p.subtotal : null;
    const sub = over ? '<small class="over">Выше лимита</small>'
      : left != null ? `<small>Осталось ${rub(left)} из ${rub(ss.limit)}</small>` : '';
    const items = p.items.map((it) => {
      const k = `${p.id}:${it.menuItemId}`;
      const age = Date.now() - (S.fresh.get(k) || 0);
      const fresh = age < 1500 ? ` fresh" style="animation-delay:-${age}ms` : '';
      return `<li class="item${showCtl ? '' : ' dim'}${fresh}"><span class="nm">${esc(it.name)}${it.unavailable ? ' <span class="tag bad">Нет в наличии</span>' : ''}<small>${it.qty} × ${rub(it.price)}</small></span>
        <span class="px">${rub(it.qty * it.price)}</span>${showCtl ? stepper(it.menuItemId, it.qty, p.id === m.id ? '' : p.id, can) : ''}</li>`;
    }).join('');
    const kick = m.isHost && !p.isHost && m.canEdit
      ? `<div class="g-foot"><button class="btn small danger" data-act="kick-open" data-pid="${p.id}">Исключить из заказа</button></div>` : '';
    return `<section class="group${mine ? ' mine' : ''}" aria-label="Заказ: ${esc(p.name)}">
      <div class="g-head">${avatar(p)}<div class="g-name"><b>${esc(p.name)}${p.isHost ? ' · хост' : ''}${mine && !p.isHost ? ' (вы)' : ''}</b>${sub}</div>
        ${p.done ? `<span class="done" title="Закончил выбор">${ICON.check}<span class="sr">Закончил выбор</span></span>` : ''}
        <span class="g-sum">${rub(p.subtotal)}</span></div>
      ${p.items.length ? `<ul class="items">${items}</ul>` : `<p class="g-empty">${mine ? 'Вы пока ничего не выбрали' : 'Пока ничего не выбрал'}</p>`}${opts && opts.kick === false ? '' : kick}</section>`;
  }

  function totalsHtml() {
    const ss = S.st.session;
    return `<dl class="totals"><div><dt>Блюда</dt><dd>${rub(ss.total)}</dd></div>
      <div><dt>Доставка</dt><dd>${rub(ss.deliveryFee)}</dd></div>
      ${ss.servicePct ? `<div><dt>Сервисный сбор ${ss.servicePct}%</dt><dd>${rub(ss.serviceFee)}</dd></div>` : ''}
      <div class="grand"><dt>Итого</dt><dd>${rub(ss.grandTotal)}</dd></div></dl>`;
  }

  function cartHtml() {
    const { session: ss, me: m, participants } = S.st;
    if (m.isHost) {
      if (ss.phase === 'waiting') {
        return `<main><div class="empty"><b>Пока никто не присоединился</b>Покажите QR-код друзьям или отправьте ссылку в чат.
          <div style="margin-top:16px"><button class="btn primary" data-act="invite">${ICON.qr} Показать QR</button></div></div>${participants.map((p) => groupHtml(p)).join('')}</main>`;
      }
      return `<main>${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
    }
    const tabs = `<div class="subtabs" role="tablist"><button role="tab" aria-selected="${S.tab === 'mine'}" data-act="tab" data-v="mine">Моё</button>
      <button role="tab" aria-selected="${S.tab === 'all'}" data-act="tab" data-v="all">Все</button></div>`;
    if (S.tab === 'mine') {
      const mineP = participants.find((p) => p.id === m.id);
      return `<main>${tabs}${mineP.items.length ? groupHtml(mineP) : '<div class="empty"><b>В корзине пусто</b>Выберите блюда в меню.</div>'}</main>`;
    }
    return `<main>${tabs}${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
  }

  function barHtml() {
    const { session: ss, me: m } = S.st;
    let inner;
    if (m.isHost) {
      inner = ss.phase === 'locked'
        ? `<button class="btn" data-act="unlock">Разблокировать</button><button class="btn primary" data-act="pay-open">${ss.live ? 'Отправить заказ' : 'Показать заказ'} · ${rub(ss.grandTotal)}</button>`
        : `<div class="bar-total"><span>Итого с доставкой</span><b>${rub(ss.grandTotal)}</b></div>
           <button class="btn primary" data-act="lock-open"${ss.total ? '' : ' aria-disabled="true"'}>К оплате</button>`;
    } else if (S.view === 'menu') {
      inner = `<button class="btn primary" data-act="view" data-v="cart">Моя корзина · ${rub(mySubtotal())}</button>`;
    } else {
      inner = m.canEdit
        ? `<button class="btn" data-act="view" data-v="menu">В меню</button>
           <button class="btn primary" data-act="done">${m.done ? 'Вернуться к выбору' : 'Готово'}</button>`
        : '<button class="btn primary" data-act="view" data-v="menu">В меню</button>';
    }
    return `<footer class="bar"><div class="bar-in">${inner}</div></footer>`;
  }

  // ---------- H7 / G7: итог и Split Bill ----------
  function hostPaidHtml() {
    const { session: ss, settlement: rows } = S.st;
    const debts = rows.filter((r) => !r.isHost);
    const left = debts.filter((r) => r.status === 'owes').reduce((a, r) => a + r.amount, 0);
    const pill = (r) => {
      const paid = r.status === 'paid';
      const claimed = !paid && r.claimed;
      const label = paid ? 'Переведено' : claimed ? 'Подтвердить' : 'К переводу';
      return `<button class="pill${paid ? ' ok' : claimed ? ' claimed' : ''}" data-act="mark" data-pid="${r.pid}" data-v="${paid ? 'owes' : 'paid'}" aria-pressed="${paid}">${label}</button>`;
    };
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)} · заказ ${esc(ss.code)}</div><h1>${esc(ss.title)}</h1></div></header>
      <section class="final"><div class="sub">Оплачено</div><div class="big">${rub(ss.grandTotal)}</div>
        <div class="sub">Ждём переводов: <b style="color:var(--ink)">${rub(left)}</b></div></section>
      <div class="stack">
        <section class="card payout-card"><label class="f" for="f-payout2">${TXT.payoutLabel}</label>
          <div class="inp-row"><input id="f-payout2" type="text" maxlength="120" autocomplete="off" value="${esc(ss.payout || '')}" placeholder="${TXT.payoutPh}">
            <button class="btn small" data-act="payout-save">Сохранить</button></div>
          <p class="hint" style="text-align:left;margin-top:8px">${ss.payout ? 'Гости видят эти реквизиты и свою сумму. Они же подставляются в расчёт и напоминания.' : 'Добавьте реквизиты: они подставятся в расчёт и напоминания, а гости увидят их у себя.'}</p></section>
        <ul class="split">${rows.map((r) => `<li><div class="who"><b>${esc(r.name)}${r.isHost ? ' · хост' : ''}</b>
          <small class="muted">блюда ${rub(r.itemsTotal)} + доставка и сервис ${rub(r.feesShare)}</small></div>
          <span class="amt">Доля: ${rub(r.amount)}</span>
          ${r.isHost ? '<span class="tag">Вы оплатили заказ</span>' : `${pill(r)}
          ${r.status === 'owes' && !r.claimed ? `<button class="btn small" data-act="remind" data-pid="${r.pid}">Напомнить</button>` : ''}`}</li>`).join('')}</ul>
        <button class="btn wide" data-act="copy-split">Скопировать расчёт</button>
        ${ss.orderNote ? `<section class="card note-card"><div class="pl">Комментарий к заказу для ресторана</div>
          <div class="pv"><code>${esc(ss.orderNote)}</code><button class="btn small" data-act="copy-note">Копировать</button></div></section>` : ''}
        <button class="btn primary wide" data-act="finish-open">Завершить заказ</button></div>`;
  }

  function guestPaidHtml() {
    const { session: ss, settlement: rows, me: m } = S.st;
    const mine = rows.find((r) => r.pid === m.id);
    const p = S.st.participants.find((x) => x.id === m.id);
    const head = `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div></header>`;
    if (!mine) {
      return `${head}<section class="final"><div class="big">Вы ничего не заказали</div><div class="sub">Переводить ничего не нужно.</div></section>${installLink()}`;
    }
    const done = mine.status === 'paid';
    const sub = done ? 'Хост подтвердил перевод. Спасибо!'
      : mine.claimed ? 'Вы отметили перевод. Ждём подтверждения хоста.' : `К переводу: ${esc(ss.hostName)}`;
    const pay = done ? '' : `<section class="card payout-card"><div class="pl">Куда перевести</div>
        <div class="pv"><b>${ss.payout ? esc(ss.payout) : 'Хост пока не указал реквизиты. Уточните их у него.'}</b></div>
        ${ss.payout ? '<button class="btn wide" data-act="copy-sbp">Скопировать номер для СБП</button>' : ''}
        <button class="btn wide" data-act="copy-amount">Скопировать сумму · ${rub(mine.amount)}</button></section>`;
    const claim = done ? '' : mine.claimed
      ? '<button class="btn wide" disabled>Перевод отмечен, ждём хоста</button>'
      : '<button class="btn primary wide" data-act="claim">Я перевёл</button>';
    return `${head}<section class="final"><div class="sub">Ваша часть</div><div class="big">${rub(mine.amount)}</div>
        <div class="sub">${sub}</div></section>
      <div class="stack">${pay}<section class="group"><ul class="items">
        ${p.items.map((it) => `<li class="item"><span class="nm">${esc(it.name)}<small>${it.qty} × ${rub(it.price)}</small></span><span class="px">${rub(it.qty * it.price)}</span></li>`).join('')}
        <li class="item"><span class="nm">Доставка и сервис (ваша часть)</span><span class="px">${rub(mine.feesShare)}</span></li></ul></section>
        ${claim}</div>${installLink()}`;
  }
  const installLink = () => '<p style="text-align:center"><a class="link" href="/host" data-act="install">Скачать приложение</a></p>';

  // ---------- Шторки ----------
  // Ползунки: лимит 300–10 000 ₽ шагом 100, таймер 5–60 мин шагом 5. Число в поле и ползунок связаны (syncRange).
  const RANGES = {
    'f-limit': { id: 'f-limit-r', min: 300, max: 10000, step: 100, def: 1500, label: 'Лимит на гостя, ползунок', lo: '300 ₽', hi: '10 000 ₽' },
    'f-timer': { id: 'f-timer-r', min: 5, max: 60, step: 5, def: 15, label: 'Время на выбор, ползунок', lo: '5 мин', hi: '60 мин' },
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rangeHtml = (field, value) => {
    const r = RANGES[field];
    const v = clamp(Number(value) || r.def, r.min, r.max);
    return `<input class="range" type="range" id="${r.id}" data-for="${field}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"
        style="--p:${((v - r.min) / (r.max - r.min)) * 100}%" aria-label="${r.label}">
      <div class="range-scale"><span>${r.lo}</span><span>${r.hi}</span></div>`;
  };
  // number -> ползунок (с привязкой к шагу и границам)
  function syncRange(field) {
    const r = RANGES[field];
    const num = document.getElementById(field);
    const rng = document.getElementById(r.id);
    if (!num || !rng) return;
    const v = Number(num.value);
    if (num.value.trim() !== '' && Number.isFinite(v)) rng.value = String(clamp(v, r.min, r.max));
    rng.style.setProperty('--p', `${((Number(rng.value) - r.min) / (r.max - r.min)) * 100}%`);
  }
  const timerBoxHtml = (value) => `<div class="inp"><input id="f-timer" type="number" inputmode="numeric" min="1" max="240" value="${value || ''}" placeholder="15" aria-label="Минут на выбор"><span>мин</span></div>
      ${rangeHtml('f-timer', value)}
      <div class="chips">${[10, 15, 30].map((v) => `<button type="button" data-act="preset" data-for="f-timer" data-v="${v}">${v} мин</button>`).join('')}</div>`;

  const limitTimerFields = (init) => `
    ${toggleRow('f-limit-on', 'Лимит на гостя', 'limit', init.limit)}
    <div class="sub" id="f-limit-box" ${init.limit ? '' : 'hidden'}>
      <div class="inp"><input id="f-limit" type="number" inputmode="numeric" min="1" max="100000" value="${init.limit || ''}" placeholder="1500" aria-label="Лимит в рублях"><span>₽</span></div>
      ${rangeHtml('f-limit', init.limit)}
      <div class="chips">${[500, 1000, 1500, 2000].map((v) => `<button type="button" data-act="preset" data-for="f-limit" data-v="${v}">${v} ₽</button>`).join('')}</div></div>`;

  function openCreate() {
    openSheet('create', 'Новый групповой заказ', `<h2>Групповой заказ</h2>
      <form data-form="create" novalidate>
        ${soloUnits() ? `<p class="carry" role="status">Уже выбрано: ${soloUnits()} ${dishWord(soloUnits())} · ${rub(soloTotal())}. Перенесём в общую корзину.</p>` : ''}
        ${fieldLabel('f-name', 'Ваше имя', 'name')}
        <input id="f-name" type="text" maxlength="24" value="${esc(store.get('go:hostname') || '')}" autocomplete="given-name" placeholder="Например, Аня" required>
        ${fieldLabel('f-title', 'Название заказа <span class="muted">(необязательно)</span>', 'title')}
        <input id="f-title" type="text" maxlength="60" placeholder="Например, Обед в офисе">
        <div style="margin-top:8px">${limitTimerFields({})}
        ${toggleRow('f-timer-on', 'Таймер выбора', 'timer', false)}
        <div class="sub" id="f-timer-box" hidden>${timerBoxHtml('')}</div></div>
        ${fieldLabel('f-payout', TXT.payoutLabel, 'payout', true)}
        <input id="f-payout" type="text" maxlength="120" autocomplete="off" value="${esc(store.get('go:payout') || '')}" placeholder="${TXT.payoutPh}">
        <p class="hint" style="text-align:left;margin-top:6px">Друзья увидят ваши реквизиты и свою сумму, когда заказ будет оплачен.</p>
        ${consentHtml('c-create', false)}
        <p class="err" id="ferr" role="alert"></p>
        <div class="acts"><button class="btn primary" type="submit" id="f-go">${TXT.createBtn}</button></div>
        <p class="hint" style="margin-top:10px">Ссылка и QR-код появятся на следующем шаге, их можно отправить в мессенджер одним нажатием. Друзья откроют её в браузере.</p></form>`);
  }

  // Корзина «для себя»: список, итог и два пути — «Заказать компанией» (превращает корзину в комнату) или оформить себе.
  function openSolo() {
    const items = soloItems();
    if (!items.length) { closeSheet(); return; }
    const r = S.restaurant;
    const total = soloTotal();
    const delivery = r.deliveryFee || 0;
    const service = Math.round((total * (r.servicePct || 0)) / 100);
    openSheet('solo', 'Моя корзина', `<h2>Моя корзина</h2>
      <ul class="items solo-items">${items.map((it) => `<li class="item"><span class="nm">${esc(it.name)}<small>${it.qty} × ${rub(it.price)}</small></span>
        <span class="px">${rub(it.qty * it.price)}</span>${soloStepper(it.id, it.qty)}</li>`).join('')}</ul>
      <dl class="totals"><div><dt>Блюда</dt><dd>${rub(total)}</dd></div><div><dt>Доставка</dt><dd>${rub(delivery)}</dd></div>
        ${service ? `<div><dt>Сервисный сбор ${r.servicePct}%</dt><dd>${rub(service)}</dd></div>` : ''}
        <div class="grand"><dt>Итого</dt><dd>${rub(total + delivery + service)}</dd></div></dl>
      <div class="acts"><button class="btn primary" data-act="create-open">${ICON.users} Заказать компанией</button>
        <button class="btn" data-act="solo-order">Оформить заказ себе</button></div>`);
  }

  function openSoloDone() {
    const r = S.restaurant;
    const total = soloTotal();
    const service = Math.round((total * (r.servicePct || 0)) / 100);
    const grand = total + (r.deliveryFee || 0) + service;
    S.solo = {}; saveSolo();
    openSheet('solo-done', 'Заказ оформлен', `<h2>Заказ оформлен</h2>
      <p>Сумма ${rub(grand)}. Это демо: оплата имитируется, деньги не списываются.</p>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Отлично</button></div>`);
    render();
  }

  // После создания комнаты блюда из одиночной корзины попадают в общую корзину хоста
  function transferSolo(list) {
    list.forEach((x, i) => setTimeout(() => send({ t: 'set_item', menuItemId: x.menuItemId, qty: x.qty }), i * 80));
    const n = list.reduce((a, x) => a + x.qty, 0);
    S.solo = {}; saveSolo();
    toast(`В общую корзину перенесено: ${n} ${dishWord(n)}`);
  }

  function readFields() {
    const out = {};
    const num = (id) => { const v = document.getElementById(id).value.trim(); return v === '' ? NaN : Number(v); };
    out.limitRub = null; out.timerMin = null;
    if (document.getElementById('f-limit-on').checked) {
      out.limitRub = num('f-limit');
      if (!Number.isInteger(out.limitRub) || out.limitRub < 1 || out.limitRub > 100000) return { error: 'Укажите лимит от 1 до 100 000 ₽' };
    }
    const t = document.getElementById('f-timer-on');
    if (t && t.checked) {
      out.timerMin = num('f-timer');
      if (!Number.isInteger(out.timerMin) || out.timerMin < 1 || out.timerMin > 240) return { error: 'Укажите время от 1 до 240 минут' };
    }
    return out;
  }

  async function submitCreate() {
    const err = document.getElementById('ferr');
    const hostName = document.getElementById('f-name').value.trim();
    if (!hostName) { err.textContent = 'Введите ваше имя'; return; }
    if (!consentOk('c-create')) { err.textContent = CONSENT_ERR; return; }
    const f = readFields();
    if (f.error) { err.textContent = f.error; return; }
    const payoutInfo = document.getElementById('f-payout').value.trim();
    const body = { restaurantId: S.restaurant.id, hostName, limitRub: f.limitRub, timerMin: f.timerMin };
    if (payoutInfo) body.payoutInfo = payoutInfo;
    const title = document.getElementById('f-title').value.trim();
    if (title) body.title = title;
    const btn = document.getElementById('f-go');
    btn.disabled = true; btn.textContent = 'Создаём…';
    try {
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      const { code, hostToken } = await r.json();
      store.set('go:hostname', hostName);
      store.set('go:payout', payoutInfo);
      store.set('go:token:' + code, hostToken);
      const carry = soloItems();
      if (carry.length) S.transfer = carry.map((m) => ({ menuItemId: m.id, qty: m.qty }));
      S.code = code; S.token = hostToken; S.showInvite = true; S.view = 'menu';
      history.replaceState(null, '', '/host/' + code + location.search);
      closeSheet();
      connect();
    } catch (e) {
      btn.disabled = false; btn.textContent = TXT.createBtn;
      err.textContent = e.message === '429' ? 'Слишком много заказов за час, попробуйте позже' : 'Не удалось создать заказ. Проверьте соединение и повторите.';
    }
  }

  // H3: приглашение — QR и ссылка
  function openInvite() {
    const url = inviteUrl();
    let qr;
    try { qr = QR.svg(url, { margin: 2, dark: '#111', light: '#fff', label: 'QR-код со ссылкой на групповой заказ' }); } catch { qr = ''; }
    openSheet('invite', 'Пригласить друзей', `<h2>Пригласите друзей</h2>
      <div class="qr">${qr}</div>
      <div class="link-box"><code dir="ltr">${esc(url)}</code><button class="btn small" data-act="copy-link">Копировать</button></div>
      ${navigator.share ? '<button class="btn wide" data-act="share" style="margin-bottom:12px">Поделиться</button>' : ''}
      <p class="joined" id="joined"></p>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Перейти к меню</button></div>`);
    updateInvite();
    // Экран не гаснет, пока QR на экране, — по возможности.
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(() => {});
  }
  function updateInvite() {
    const el = document.getElementById('joined');
    if (!el || !S.st) return;
    const guests = S.st.participants.filter((p) => !p.isHost);
    el.innerHTML = `Присоединились: ${guests.length}` + (guests.length ? `<small>${guests.map((g) => esc(g.name)).join(', ')}</small>` : '<small>Покажите QR друзьям или отправьте ссылку в чат</small>');
  }

  function openSettings() {
    const ss = S.st.session;
    const timer = ss.deadlineAt
      ? `<p class="row" style="margin:0">Таймер: <span data-timer><span>${ss.phase === 'time_up' ? '00:00' : clockText(remaining())}</span></span></p>
         <div class="chips"><button data-act="extend" data-min="5">+5 мин</button><button data-act="extend" data-min="10">+10 мин</button><button data-act="timer-off">Выключить</button></div>`
      : `<div class="sub">${timerBoxHtml('')}<button class="btn small" data-act="timer-on" style="margin-top:12px">Включить таймер</button></div>`;
    openSheet('settings', 'Настройки заказа', `<h2>Настройки заказа</h2>
      ${limitTimerFields({ limit: ss.limit ? ss.limit / 100 : 0 })}
      <p class="err" id="ferr" role="alert"></p>
      <button class="btn small" data-act="save-limit">Сохранить лимит</button>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">${timer}
      <div class="acts"><button class="btn danger" data-act="cancel-open">Отменить групповой заказ</button></div>`);
  }

  function confirmSheet(kind, title, text, okLabel, okAct, extra) {
    openSheet(kind, title, `<h2>${esc(title)}</h2><p>${text}</p>${extra || ''}
      <div class="acts"><button class="btn primary" data-act="${okAct}">${esc(okLabel)}</button><button class="btn" data-act="close-sheet">Отмена</button></div>`);
  }

  function openLimit(msg) {
    openSheet('limit', 'Лимит превышен', `<h2>Это превысит ваш лимит</h2>
      <p>Лимит на гостя — ${rub(msg.limit)}. Осталось ${rub(msg.remaining)}.</p>
      <div class="acts"><button class="btn primary" data-act="limit-ok">Выбрать другое</button></div>`);
  }

  // «Заказ собран»: текст с адресом собирается только на телефоне хоста, на сервер адрес не уходит.
  function wireOrder() {
    const ad = document.getElementById('f-addr'), ta = document.getElementById('ord-text');
    if (!ad || !ta || S.st.session.live) return;
    const c = S.st.session.contacts || {};
    const refresh = () => {
      const addr = ad.value.trim();
      const text = (S.st.session.orderText || '').replace('Адрес и время напишу.', addr ? `Адрес: ${addr}\nВремя: как можно скорее.` : 'Адрес и время напишу.');
      ta.value = text;
      const q = encodeURIComponent(text);
      const long = q.length > 1800; // слишком длинный текст в ссылку не помещается: остаётся «Скопировать»
      document.querySelectorAll('#chan [data-ch]').forEach((a) => {
        const ch = a.dataset.ch;
        a.href = ch === 'wa' ? `https://wa.me/${c.wa}?text=${q}` : ch === 'tg' ? `https://t.me/${c.tg}?text=${q}` : `tel:${c.tel}`;
        a.hidden = long && ch !== 'tel';
      });
      if (addr) store.set('go:addr', addr);
    };
    ad.addEventListener('input', refresh);
    refresh();
  }

  // ---------- Действия ----------
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
      ta.remove();
      return ok;
    }
  };

  // Телефон из строки реквизитов («+7 999 000-00-00, Т-Банк»), чтобы копировать только номер для СБП
  const phoneOf = (t) => { const m = /\+?\d[\d\s()\-]{8,}\d/.exec(t || ''); return m ? m[0].trim() : null; };
  const payoutLine = () => {
    const ss = S.st.session;
    return ss.payout ? `Куда перевести: ${ss.payout} (${ss.hostName})` : `Перевести нужно: ${ss.hostName}`;
  };
  // Личное сообщение гостю: точная сумма и реквизиты подставляются автоматически
  const remindText = (r) => [
    `${r.name}, привет! Заказ «${S.st.session.title}» оплачен.`,
    `Твоя часть: ${rub(r.amount)} (блюда ${rub(r.itemsTotal)} + доставка и сервис ${rub(r.feesShare)}).`,
    payoutLine(),
  ].join('\n');
  // Общий расчёт для чата: у каждого своя сумма, внизу реквизиты
  const splitText = () => {
    const { session: ss, settlement } = S.st;
    const rows = settlement.filter((r) => !r.isHost);
    return [`Заказ «${ss.title}»: ${rub(ss.grandTotal)}`,
      ...rows.map((r) => `${r.name}: ${rub(r.amount)}${r.status === 'paid' ? ' ✓' : ''}`),
      payoutLine()].join('\n');
  };

  function centerCategory() {
    const el = document.querySelector('.cats [aria-pressed="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function disabledReason() {
    if (!S.connected) return 'Нет связи. Пробуем подключиться…';
    const ph = S.st && S.st.session.phase;
    if (ph === 'locked') return 'Корзина заблокирована';
    if (ph === 'time_up') return 'Время выбора вышло';
    return 'Сейчас это недоступно';
  }

  const ACT = {
    'close-sheet': () => closeSheet(),
    'tip-close': () => { store.set('go:tip', '1'); render(); },
    'create-open': () => { if (store.get('go:onb')) openCreate(); else { store.set('go:onb', '1'); openOnboarding(); } },
    'onb-go': () => openCreate(),
    'about-open': () => openAbout(),
    help: (d, el) => {
      const pop = document.getElementById(d.for);
      if (!pop) return;
      pop.hidden = !pop.hidden;
      el.setAttribute('aria-expanded', String(!pop.hidden));
    },
    preset: (d) => { document.getElementById(d.for).value = d.v; syncRange(d.for); },
    cat: (d) => { S.cat = d.v || null; render(); centerCategory(); },
    'solo-set': (d) => {
      const q = clamp(Number(d.qty), 0, 20);
      if (q > 0) S.solo[d.mid] = q; else delete S.solo[d.mid];
      saveSolo();
      render();
      if (S.sheet === 'solo') openSolo();
    },
    'solo-open': () => openSolo(),
    'solo-order': () => openSoloDone(),
    'payout-save': () => {
      const v = document.getElementById('f-payout2').value.trim();
      if (send({ t: 'set_payout', text: v })) { store.set('go:payout', v); toast(v ? 'Реквизиты сохранены' : 'Реквизиты убраны'); }
    },
    'copy-sbp': async () => {
      const text = S.st.session.payout;
      const phone = phoneOf(text);
      toast((await copyText(phone || text)) ? (phone ? 'Номер для СБП скопирован' : 'Реквизиты скопированы') : 'Не удалось скопировать');
    },
    claim: () => { send({ t: 'claim_paid' }); toast('Отметили, что вы перевели'); },
    'copy-note': async () => toast((await copyText(S.st.session.orderNote)) ? 'Пометка скопирована' : 'Не удалось скопировать'),
    view: (d) => { S.view = d.v; render(); window.scrollTo(0, 0); },
    tab: (d) => { S.tab = d.v; render(); },
    qty: (d) => {
      const msg = { t: 'set_item', menuItemId: Number(d.mid), qty: Number(d.qty) };
      if (d.pid) msg.targetId = Number(d.pid);
      send(msg);
    },
    done: () => { send({ t: 'set_done', done: !me().done }); if (!me().done) S.view = 'menu'; },
    'limit-ok': () => { closeSheet(); S.view = 'menu'; render(); },
    invite: () => openInvite(),
    'copy-link': async () => { toast((await copyText(inviteUrl())) ? 'Ссылка скопирована' : 'Не удалось скопировать'); send({ t: 'track', name: 'invite_shared' }); },
    share: () => { navigator.share({ title: S.st.session.title, text: 'Присоединяйтесь к заказу', url: inviteUrl() }).then(() => send({ t: 'track', name: 'invite_shared' })).catch(() => {}); },
    settings: () => openSettings(),
    'save-limit': () => {
      const f = readFields();
      if (f.error) { document.getElementById('ferr').textContent = f.error; return; }
      if (send({ t: 'settings', limitRub: f.limitRub })) { closeSheet(); toast('Лимит сохранён'); }
    },
    extend: (d) => { if (send({ t: 'extend', minutes: Number(d.min) })) toast(`Время продлено на ${d.min} мин`); },
    'timer-off': () => { send({ t: 'settings', timerMin: null }); closeSheet(); },
    'timer-on': () => {
      const v = Number(document.getElementById('f-timer').value);
      if (!Number.isInteger(v) || v < 1 || v > 240) { document.getElementById('ferr').textContent = 'Укажите время от 1 до 240 минут'; return; }
      send({ t: 'settings', timerMin: v }); closeSheet();
    },
    'kick-open': (d) => {
      const p = S.st.participants.find((x) => x.id === Number(d.pid));
      if (p) confirmSheet('kick', `Исключить ${p.name}?`, 'Его блюда будут удалены из общей корзины.', 'Исключить', 'kick', `<input type="hidden" id="kick-pid" value="${p.id}">`);
    },
    kick: () => { send({ t: 'kick', participantId: Number(document.getElementById('kick-pid').value) }); closeSheet(); },
    'lock-open': () => {
      const ss = S.st.session;
      if (!ss.total) return toast(ERR.cart_empty);
      const warn = ss.unavailable ? `<p style="color:var(--danger)"><b>В заказе есть недоступные блюда: ${ss.unavailable}.</b> Лучше заменить их до оплаты.</p>` : '';
      return confirmSheet('lock', 'Заблокировать корзину?', 'Гости больше не смогут менять заказ. Продолжить?', 'Заблокировать и оплатить', 'lock', warn);
    },
    lock: () => { closeSheet(); send({ t: 'lock' }); },
    unlock: () => send({ t: 'unlock' }),
    'pay-open': () => {
      setTimeout(wireOrder, 0);
      const n = S.st.participants.filter((p) => p.subtotal > 0).length;
      const total = rub(S.st.session.grandTotal);
      if (S.st.session.live) {
        const f = `<label class="f" for="f-phone">Телефон для связи</label><input id="f-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="+7 900 000-00-00" value="${esc(store.get('go:phone') || '')}">
          <label class="f" for="f-addr">Адрес доставки</label><input id="f-addr" autocomplete="street-address" maxlength="160" placeholder="Улица, дом, квартира, подъезд" value="${esc(store.get('go:addr') || '')}">
          ${consentHtml('c-pay', false)}
          <p id="pay-err" class="err" role="alert"></p>`;
        return confirmSheet('pay', 'Отправить заказ', `Сумма — <b>${total}</b>. Заказ уйдёт в ресторан, оплата при получении, как обычно.<br>Пометка для ресторана: <b>[Совместный заказ · ${n} чел.]</b>`, 'Отправить заказ', 'pay', f);
      }
      const c = S.st.session.contacts || {};
      return confirmSheet('pay', 'Заказ собран', `Итого — <b>${total}</b>. Укажите адрес один раз, он сохранится только на этом телефоне. Затем отправьте заказ ресторану одним нажатием.`, 'Готово', 'pay',
        `<label class="f" for="f-addr">Адрес доставки (по желанию)</label><input id="f-addr" autocomplete="street-address" maxlength="160" placeholder="Улица, дом, квартира, подъезд" value="${esc(store.get('go:addr') || '')}">
        <div class="chan" id="chan">${c.wa ? '<a class="btn" data-ch="wa" target="_blank" rel="noopener">WhatsApp</a>' : ''}${c.tg ? '<a class="btn" data-ch="tg" target="_blank" rel="noopener">Telegram</a>' : ''}${c.tel ? '<a class="btn" data-ch="tel">Позвонить</a>' : ''}</div>
        <textarea id="ord-text" class="ord-text" readonly rows="10" aria-label="Текст заказа"></textarea><button class="btn" data-act="copy-order">Скопировать заказ</button>`);
    },
    'copy-order': async () => {
      const ta = document.getElementById('ord-text');
      if (ta && await copyText(ta.value)) toast('Заказ скопирован');
    },
    pay: () => {
      const ph = document.getElementById('f-phone'), ad = document.getElementById('f-addr');
      if (ph && ad) {
        const phone = ph.value.trim(), address = ad.value.trim();
        const err = document.getElementById('pay-err');
        if (!/^[+\d][\d\s()-]{6,18}$/.test(phone)) { err.textContent = 'Введите телефон'; ph.focus(); return; }
        if (!address) { err.textContent = 'Введите адрес доставки'; ad.focus(); return; }
        if (!consentOk('c-pay')) { err.textContent = CONSENT_ERR; return; }
        store.set('go:phone', phone); store.set('go:addr', address);
        closeSheet(); send({ t: 'pay', phone, address });
        return;
      }
      closeSheet(); send({ t: 'pay' });
    },
    mark: (d) => send({ t: 'mark_debt', participantId: Number(d.pid), status: d.v }),
    remind: async (d) => {
      const r = S.st.settlement.find((x) => x.pid === Number(d.pid));
      toast((await copyText(remindText(r))) ? 'Текст напоминания скопирован' : 'Не удалось скопировать');
    },
    'copy-split': async () => toast((await copyText(splitText())) ? 'Расчёт скопирован' : 'Не удалось скопировать'),
    'copy-amount': async () => {
      const r = S.st.settlement.find((x) => x.pid === me().id);
      toast((await copyText(String(r.amount / 100))) ? 'Сумма скопирована' : 'Не удалось скопировать');
    },
    'finish-open': () => confirmSheet('finish', 'Завершить заказ?', 'Расчёт перестанет быть доступен гостям по ссылке.', 'Завершить', 'close'),
    'cancel-open': () => confirmSheet('cancel', 'Отменить групповой заказ?', 'Гости увидят, что заказ отменён. Корзина будет потеряна.', 'Отменить заказ', 'close'),
    close: () => { closeSheet(); send({ t: 'close' }); },
    install: () => send({ t: 'track', name: 'guest_app_install_tap' }),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'install') { ACT.install(); return; } // ссылка работает как обычно
    e.preventDefault();
    if (el.getAttribute('aria-disabled') === 'true') {
      toast(el.dataset.act === 'lock-open' ? ERR.cart_empty : disabledReason());
      return;
    }
    if (ACT[act]) ACT[act](el.dataset, el);
  });

  // Включили лимит или таймер: поле сразу получает значение ползунка, чтобы можно было сразу создавать
  function fillDefault(field) {
    const num = document.getElementById(field);
    if (num && num.value.trim() === '') num.value = document.getElementById(RANGES[field].id).value;
    syncRange(field);
  }
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-limit-on') { document.getElementById('f-limit-box').hidden = !e.target.checked; if (e.target.checked) fillDefault('f-limit'); }
    if (e.target.id === 'f-timer-on') { document.getElementById('f-timer-box').hidden = !e.target.checked; if (e.target.checked) fillDefault('f-timer'); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'nm') S.draftName = t.value;
    if (t.id === 'c-join') S.consent = t.checked; // перерисовка не должна сбрасывать отметку
    if (t.classList && t.classList.contains('range')) { document.getElementById(t.dataset.for).value = t.value; syncRange(t.dataset.for); }
    if (t.id === 'f-limit' || t.id === 'f-timer') syncRange(t.id);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'create') submitCreate();
    if (form.dataset.form === 'join') {
      const name = document.getElementById('nm').value.trim();
      if (!name) { document.getElementById('nerr').textContent = 'Введите имя'; return; }
      if (!consentOk('c-join')) { document.getElementById('nerr').textContent = CONSENT_ERR; return; }
      send({ t: 'join', name });
    }
  });

  // ---------- Рендер и таймер ----------
  // Перерисовка заменяет DOM целиком, поэтому запоминаем горизонтальный скролл категорий
  // и поле ввода в фокусе (иначе реквизиты пропадали бы на полуслове при каждом обновлении).
  function render() {
    const y = window.scrollY;
    const catsLeft = (document.querySelector('.cats') || {}).scrollLeft || 0;
    const ae = document.activeElement;
    const focus = ae && ae.id && $app.contains(ae) && ae.tagName === 'INPUT'
      ? { id: ae.id, value: ae.value, from: ae.selectionStart, to: ae.selectionEnd } : null;
    let html;
    if (S.fatal) html = fatalHtml();
    else if (S.role === 'host' && !S.code) html = hostHomeHtml();
    else if (!S.st) html = S.anon ? nameHtml() : '<p class="boot">Подключаемся…</p>';
    else html = sessionHtml();
    $app.innerHTML = html;
    window.scrollTo(0, y);
    const cats = document.querySelector('.cats');
    if (cats) cats.scrollLeft = catsLeft;
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) { el.value = focus.value; el.focus(); try { el.setSelectionRange(focus.from, focus.to); } catch { /* тип поля без выделения */ } }
    }
    if (S.sheet === 'invite') updateInvite();
    if (S.st && S.st.session.phase === 'paid' && !S.trackedPaid) { S.trackedPaid = true; send({ t: 'track', name: 'split_bill_viewed' }); }
    tickTimers();
  }

  function tickTimers() {
    const ss = S.st && S.st.session;
    if (!ss || !ss.deadlineAt) return;
    const rem = remaining();
    document.querySelectorAll('[data-timer]').forEach((el) => {
      const txt = el.querySelector('span');
      if (txt) txt.textContent = ss.phase === 'time_up' ? '00:00' : clockText(rem);
      el.classList.toggle('warn', ss.phase === 'time_up' || (rem <= 120000 && rem > 0));
    });
    if (ss.phase === 'selecting' && rem <= 120000 && rem > 0 && S.warned !== ss.deadlineAt) {
      S.warned = ss.deadlineAt;
      toast('Осталось 2 минуты');
      live('Осталось 2 минуты');
    }
  }
  setInterval(tickTimers, 1000);

  // Во фрейме виджета Esc (когда не открыта шторка) просит оболочку закрыть виджет.
  if (window.parent !== window) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.querySelector('.sheet')) window.parent.postMessage({ goWidget: 'close' }, '*');
    });
  }

  // ---------- Старт ----------
  render();
  if (S.role === 'host' && !S.code) {
    fetch(qs.get('k') ? '/api/r/' + encodeURIComponent(qs.get('k')) + '/menu' : '/api/active/menu').then((r) => r.json()).then((d) => { S.menu = d.menu; S.restaurant = d.restaurant; render(); })
      .catch(() => { $app.innerHTML = '<p class="boot">Не удалось загрузить меню. Обновите страницу.</p>'; });
  } else if (S.code) {
    connect();
  }
})();
