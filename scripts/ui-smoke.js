'use strict';
// Браузерная проверка сценария: хост + два гостя в разных контекстах (как три телефона).
// Запуск: node --disable-warning=ExperimentalWarning scripts/ui-smoke.js [папка-для-скриншотов]
// Нужен Playwright с установленным Chromium (в репозиторий не входит).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createApp } = require('../server');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'group-order-shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const norm = (s) => s.replace(/[  ]/g, ' ');

(async () => {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const newPhone = async (label) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`));
    return page;
  };
  // Пауза, чтобы закончились анимации шторок и подсветок: иначе снимок получается полупрозрачным
  const shot = async (page, name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
  };
  const clip = (page) => page.evaluate(() => navigator.clipboard.readText()).then(norm);

  try {
    // ---------- Главный экран: категории не сбрасываются, одиночная корзина ----------
    const host = await newPhone('host');
    await host.goto(base + '/host');
    await host.getByRole('button', { name: 'В корзину: Маргарита' }).waitFor();
    await shot(host, '01-home');
    check('в шапке есть «Заказать компанией», на карточках «+ В корзину»',
      (await host.locator('.top').getByRole('button', { name: /Заказать компанией/ }).count()) === 1
      && (await host.locator('.add-solo').count()) > 5
      && (await host.locator('.add-solo').first().innerText()).trim() === '+ В корзину');

    await host.locator('.about-btn').click();
    await host.locator('.about').first().waitFor();
    const aboutTxt = norm(await host.locator('.sheet').innerText());
    check('«?» в шапке открывает «О совместном заказе» с примерами и FAQ',
      ['Что это', 'Как это работает', 'Как заполнять поля', 'Пример расчёта', 'Частые вопросы'].every((h) => aboutTxt.includes(h))
      && aboutTxt.includes('+7 900 123-45-67, Т-Банк'));
    await shot(host, '01b-about');
    await host.locator('.sheet').getByRole('button', { name: 'Понятно', exact: true }).click();
    check('модалка закрывается', (await host.locator('.sheet').count()) === 0);

    const dims = await host.locator('.cats').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    check('полоса категорий прокручивается по горизонтали', dims.sw > dims.cw, `${dims.sw} > ${dims.cw}`);
    await host.locator('.cats').evaluate((el) => { el.scrollLeft = 40; });
    await host.locator('.cats').getByRole('button', { name: 'Десерты' }).click();
    await host.waitForTimeout(700); // плавная прокрутка
    const cat = await host.locator('.cats').evaluate((el) => {
      const b = el.querySelector('[aria-pressed="true"]').getBoundingClientRect();
      const c = el.getBoundingClientRect();
      return { left: el.scrollLeft, visible: b.left >= c.left - 1 && b.right <= c.right + 1 };
    });
    check('после клика по категории полоса не сбрасывается влево, активная видна', cat.left > 40 && cat.visible, `scrollLeft=${cat.left}`);
    await host.locator('.cats').getByRole('button', { name: 'Все' }).click();

    // Одиночная корзина: Маргарита 520 ₽ + Лимонад 250 ₽
    await host.getByRole('button', { name: 'В корзину: Маргарита' }).click();
    await host.getByRole('button', { name: 'В корзину: Лимонад домашний' }).click();
    const bar = host.getByRole('button', { name: /Моя корзина \(2 блюда · 770 ₽\)/ });
    await bar.waitFor();
    check('плавающая плашка «Моя корзина (N блюд · Сумма ₽)»', true);
    await host.getByRole('button', { name: 'Добавить порцию' }).first().click(); // Маргарита ×2 → 3 блюда, 1290 ₽
    await host.getByRole('button', { name: /Моя корзина \(3 блюда · 1 290 ₽\)/ }).waitFor();
    await host.getByRole('button', { name: 'Убрать одну порцию' }).first().click(); // назад: 2 блюда
    await bar.waitFor();
    await shot(host, '02-home-cart-bar');

    await bar.click();
    const cartSheet = host.locator('.sheet');
    await cartSheet.getByText('Итого').waitFor();
    check('в корзине есть «Заказать компанией» и «Оформить заказ себе»',
      (await cartSheet.getByRole('button', { name: /Заказать компанией/ }).count()) === 1
      && (await cartSheet.getByRole('button', { name: 'Оформить заказ себе' }).count()) === 1);
    await shot(host, '03-solo-cart-sheet');
    await cartSheet.getByRole('button', { name: /Заказать компанией/ }).click();

    // ---------- Онбординг при первом клике ----------
    await host.locator('.steps').waitFor();
    check('первый клик: онбординг с тремя шагами', (await host.locator('.steps li').count()) === 3
      && norm(await host.locator('.sheet h2').innerText()).includes('Закажите вместе'));
    await shot(host, '03b-onboarding');
    await host.getByRole('button', { name: 'Понятно, создать ссылку' }).click();

    // ---------- Создание группового заказа: ползунки, реквизиты ----------
    await host.locator('#f-name').waitFor();
    check('есть плейсхолдеры-примеры', (await host.locator('#f-name').getAttribute('placeholder')) === 'Например, Аня'
      && (await host.locator('#f-title').getAttribute('placeholder')) === 'Например, Обед в офисе'
      && (await host.locator('#f-payout').getAttribute('placeholder')).includes('+7 900 123-45-67'));
    check('мягкая подпись реквизитов и новая кнопка', norm(await host.locator('.sheet').innerText()).includes('Куда друзьям перевести свою часть?')
      && !norm(await host.locator('.sheet').innerText()).includes('Куда переводить')
      && (await host.locator('#f-go').innerText()).trim() === 'Позвать друзей по ссылке');
    const hp = host.locator('.help[data-for="h-payout"]');
    check('подсказка (?) скрыта и раскрывается по клику', !(await host.locator('#h-payout').isVisible()));
    await hp.click();
    check('после клика подсказка видна, aria-expanded=true', (await host.locator('#h-payout').isVisible()) && (await hp.getAttribute('aria-expanded')) === 'true');
    await shot(host, '03c-create-help');
    await hp.click();
    check('повторный клик скрывает подсказку', !(await host.locator('#h-payout').isVisible()));
    check('в форме создания видно, что блюда будут перенесены',
      norm(await host.locator('.carry').innerText()).includes('Уже выбрано: 2 блюда · 770 ₽'));
    await host.locator('#f-name').fill('Олег');
    await host.locator('#f-limit-on').check();
    check('при включении лимита поле получает значение ползунка (1500)', (await host.locator('#f-limit').inputValue()) === '1500');
    const lim = await host.locator('#f-limit-r').evaluate((el) => ({ min: el.min, max: el.max, step: el.step, type: el.type }));
    check('ползунок лимита: 300–10 000 ₽, шаг 100', lim.type === 'range' && lim.min === '300' && lim.max === '10000' && lim.step === '100', JSON.stringify(lim));
    await host.locator('#f-limit-r').evaluate((el) => { el.value = '700'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('ползунок → поле лимита', (await host.locator('#f-limit').inputValue()) === '700');
    await host.locator('#f-limit').fill('2000');
    check('поле лимита → ползунок', (await host.locator('#f-limit-r').inputValue()) === '2000');
    await host.getByRole('button', { name: '1000 ₽' }).click();
    check('быстрая кнопка → поле и ползунок', (await host.locator('#f-limit').inputValue()) === '1000' && (await host.locator('#f-limit-r').inputValue()) === '1000');

    await host.locator('#f-timer-on').check();
    check('при включении таймера поле получает значение ползунка (15)', (await host.locator('#f-timer').inputValue()) === '15');
    const tm = await host.locator('#f-timer-r').evaluate((el) => ({ min: el.min, max: el.max, step: el.step }));
    check('ползунок таймера: 5–60 мин, шаг 5', tm.min === '5' && tm.max === '60' && tm.step === '5', JSON.stringify(tm));
    await host.locator('#f-timer-r').evaluate((el) => { el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('ползунок → поле таймера', (await host.locator('#f-timer').inputValue()) === '45');
    await host.locator('.chips').getByRole('button', { name: '30 мин' }).click();
    check('быстрая кнопка таймера двигает ползунок', (await host.locator('#f-timer-r').inputValue()) === '30');

    await host.locator('#f-payout').fill('+7 999 000-00-00, Т-Банк');
    await shot(host, '04-create-sheet-sliders');
    await host.locator('#f-go').click();
    await host.locator('.link-box code').waitFor();
    const url = (await host.locator('.link-box code').innerText()).trim();
    check('хост получил короткую ссылку', /\/j\/[A-Z0-9]{6}$/.test(url), url);
    check('на экране приглашения есть QR-код', (await host.locator('.sheet svg').count()) > 0);
    await shot(host, '05-host-invite-qr');
    await host.locator('.acts button[data-act="close-sheet"]').click();

    // Блюда из одиночной корзины перенеслись в комнату хоста, одиночная корзина пуста
    await host.getByRole('tab', { name: /Корзина/ }).click();
    await host.locator('.group.mine').getByText('Маргарита').waitFor();
    check('выбранные блюда перенесены в общую корзину хоста',
      (await host.locator('.group.mine').getByText('Лимонад домашний').count()) === 1);
    check('одиночная корзина после переноса очищена', (await host.evaluate(() => localStorage.getItem('go:solo'))) === '{}');

    // ---------- Гости входят по ссылке только с именем ----------
    const anya = await newPhone('anya');
    await anya.goto(url);
    await anya.locator('#nm').waitFor();
    await anya.locator('#nm').fill('Аня');
    await anya.locator('#nm').press('Enter');
    await anya.getByRole('button', { name: 'Добавить: Маргарита' }).waitFor();
    check('гость вошёл без регистрации и видит меню', true);

    const boris = await newPhone('boris');
    await boris.goto(url);
    await boris.locator('#nm').fill('Борис');
    await boris.locator('#nm').press('Enter');
    await boris.getByRole('button', { name: 'Добавить: Карбонара' }).waitFor();

    // ---------- Реальное время и уведомления сверху ----------
    const t0 = Date.now();
    await anya.getByRole('button', { name: 'Добавить: Маргарита' }).click();
    await host.locator('.group', { hasText: 'Аня' }).getByText('Маргарита').waitFor();
    const lat = Date.now() - t0;
    check('блюдо Ани появилось у хоста без перезагрузки, задержка < 1 с', lat < 1000, `${lat} мс`);

    await host.locator('.toast').first().waitFor();
    const toastSeenAt = Date.now();
    const toast = await host.locator('.toast').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const anchor = (document.querySelector('.strip') || document.querySelector('.top')).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: innerHeight, headBottom: anchor.bottom, scrolled: scrollY };
    });
    check('уведомление выводится сверху, под шапкой и строкой с итогом, а не внизу',
      toast.top < 200 && toast.bottom < toast.vh / 2 && (toast.scrolled > 0 || toast.top >= toast.headBottom - 1),
      `top=${Math.round(toast.top)} headBottom=${Math.round(toast.headBottom)}`);
    await shot(host, '06-host-toast-top');
    await host.waitForFunction(() => document.querySelectorAll('.toast').length === 0, null, { timeout: 4000 });
    const lived = Date.now() - toastSeenAt;
    check('уведомление само исчезает примерно через 2,5 с', lived >= 2100 && lived <= 2900, `${lived} мс`);

    await boris.getByRole('button', { name: 'Добавить: Карбонара' }).click();
    await host.locator('.group', { hasText: 'Борис' }).getByText('Карбонара').waitFor();
    check('в корзине хоста подписано, кто что добавил',
      (await host.locator('body').innerText()).includes('Аня') && (await host.locator('body').innerText()).includes('Борис'));
    await shot(host, '07-host-cart');

    // ---------- Лимит 1000 ₽ ----------
    await anya.getByRole('button', { name: 'Добавить: Пепперони' }).click();
    await anya.getByRole('button', { name: 'Выбрать другое' }).waitFor();
    check('превышение лимита блокируется шторкой', true);
    await anya.getByRole('button', { name: 'Выбрать другое' }).click();

    await anya.getByRole('tab', { name: /Корзина/ }).click();
    await anya.getByRole('tab', { name: 'Все' }).click();
    check('у чужих позиций нет кнопок изменения',
      (await anya.locator('.group', { hasText: 'Борис' }).locator('[data-act="qty"]').count()) === 0);

    // ---------- Блокировка ----------
    await host.locator('[data-act="lock-open"]').click();
    await host.locator('button[data-act="lock"]').click();
    await anya.getByText(/Хост оформляет заказ/).first().waitFor();
    await anya.getByRole('tab', { name: /Меню/ }).click();
    check('кнопки добавления отключены при блокировке',
      (await anya.getByRole('button', { name: 'Добавить: Хумус с лепёшкой' }).getAttribute('aria-disabled')) === 'true');

    // ---------- Оплата: пометка для ресторана ----------
    await host.locator('[data-act="pay-open"]').click();
    const payText = norm(await host.locator('.sheet').innerText());
    check('при оплате формируется пометка [Совместный заказ · 3 чел.]', payText.includes('[Совместный заказ · 3 чел.]'));
    await shot(host, '08-host-pay-confirm');
    await host.locator('button[data-act="pay"]').click();
    await host.getByText('Скопировать расчёт').waitFor();
    await anya.getByText('Ваша часть').first().waitFor();

    // ---------- Мягкие формулировки ----------
    const hostTxt = norm(await host.locator('body').innerText());
    const guestTxt = norm(await anya.locator('body').innerText());
    check('в Split Bill нет слов «должен/должны» ни у хоста, ни у гостя', !/долж/i.test(hostTxt + guestTxt));
    check('у хоста «Доля: …» и статус «К переводу»', /Доля: \d/.test(hostTxt) && hostTxt.includes('К переводу'));
    check('у гостя «Ваша часть» и «Куда перевести» с реквизитами хоста',
      guestTxt.includes('Ваша часть') && guestTxt.includes('Куда перевести') && guestTxt.includes('+7 999 000-00-00, Т-Банк'));
    check('у хоста показана пометка для ресторана', hostTxt.includes('[Совместный заказ · 3 чел.]'));
    await shot(host, '09-host-split-bill');
    await shot(anya, '10-guest-split-bill');

    // ---------- Буфер обмена: номер для СБП, напоминание, расчёт ----------
    await anya.getByRole('button', { name: 'Скопировать номер для СБП' }).click();
    check('гость копирует только номер для СБП', (await clip(anya)) === '+7 999 000-00-00');
    const anyaAmount = norm(await anya.locator('.final .big').innerText());
    await host.locator('li', { hasText: 'Аня' }).getByRole('button', { name: 'Напомнить' }).click();
    const remind = await clip(host);
    check('в напоминании точная сумма гостя и реквизиты хоста',
      remind.includes('Аня') && remind.includes(`Твоя часть: ${anyaAmount}`) && remind.includes('+7 999 000-00-00, Т-Банк'), remind.replace(/\n/g, ' | '));
    await host.getByRole('button', { name: 'Скопировать расчёт' }).click();
    const split = await clip(host);
    check('в «Скопировать расчёт» суммы всех гостей и реквизиты',
      split.includes('Аня:') && split.includes('Борис:') && split.includes('Куда перевести: +7 999 000-00-00, Т-Банк (Олег)') && !/долж/i.test(split), split.replace(/\n/g, ' | '));

    // ---------- «Я перевёл» ----------
    await anya.getByRole('button', { name: 'Я перевёл' }).click();
    await host.getByRole('button', { name: 'Подтвердить' }).waitFor();
    check('«Я перевёл» меняет статус гостя у хоста', true);
    await shot(host, '11-host-claimed');
    await anya.getByText(/Ждём подтверждения хоста/).first().waitFor();
    await host.getByRole('button', { name: 'Подтвердить' }).click();
    await anya.getByText('Хост подтвердил перевод. Спасибо!').waitFor();
    check('хост подтверждает перевод, гость это видит', true);

    // ---------- Поле реквизитов у хоста не стирается при обновлении ----------
    await host.locator('#f-payout2').click();
    await host.locator('#f-payout2').fill('+7 900 111-22-33, Сбер');
    await boris.getByRole('button', { name: 'Я перевёл' }).click(); // приходит обновление состояния
    await host.getByRole('button', { name: 'Подтвердить' }).waitFor();
    check('текст в поле реквизитов не пропал при обновлении состояния', (await host.locator('#f-payout2').inputValue()) === '+7 900 111-22-33, Сбер');
    await host.getByRole('button', { name: 'Сохранить' }).click();
    await boris.getByText('+7 900 111-22-33, Сбер').waitFor();
    check('новые реквизиты сразу видны гостю', true);

    // ---------- /stats ----------
    const stats = await newPhone('stats');
    await stats.goto(base + '/stats');
    await stats.getByText('Итоги теста').waitFor();
    const st = app.svc.stats();
    const sTxt = norm(await stats.locator('body').innerText());
    const rubTxt = (kop) => norm((kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: kop % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' ₽');
    check('/stats: заказы, выручка и средний чек совпадают с базой',
      st.orders === 1 && sTxt.includes(rubTxt(st.revenue)) && sTxt.includes('Совместных заказов'), `${st.orders} заказ, ${rubTxt(st.revenue)}`);
    await shot(stats, '12-stats');

    // ---------- Оформление заказа себе ----------
    const solo = await newPhone('solo');
    await solo.goto(base + '/host');
    await solo.getByRole('button', { name: 'В корзину: Хумус с лепёшкой' }).click();
    await solo.getByRole('button', { name: /Моя корзина/ }).click();
    await solo.getByRole('button', { name: 'Оформить заказ себе' }).click();
    await solo.getByText('Заказ оформлен').first().waitFor();
    check('одиночный заказ оформляется (демо) и корзина очищается',
      (await solo.getByRole('button', { name: /Моя корзина/ }).count()) === 0);

    check('в консоли браузеров нет ошибок', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('сценарий дошёл до конца', false, e.message.split('\n').slice(0, 3).join(' / '));
  } finally {
    await browser.close();
    app.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nСкриншоты: ${OUT}\nИтого: ${results.length - failed} из ${results.length}`);
  process.exit(failed ? 1 : 0);
})();
