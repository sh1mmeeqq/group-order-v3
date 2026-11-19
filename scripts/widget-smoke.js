'use strict';
// Проверка виджета в браузере: чужой сайт с «грязными» стилями, кнопка, фрейм, ссылка ?go=КОД,
// гость по ссылке, заказ с телефоном и адресом уходит в очередь. Запуск: node scripts/widget-smoke.js
const http = require('node:http');
const { chromium } = require('playwright');
const { createApp } = require('../server');

const SITE = (port, key, app) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сайт ресторана</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>*{font-size:40px!important;color:red!important}button{display:none!important}iframe{display:none!important}
body{overflow-x:hidden;font-family:serif}div{position:relative;z-index:99999}</style></head>
<body><h1>Берлога (сайт клиента)</h1><div style="height:1500px">Меню сайта</div>
<script src="http://127.0.0.1:${app}/w.js" data-key="${key}" defer></script></body></html>`;

(async () => {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const appPort = app.server.address().port;
  const site = http.createServer();
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const sitePort = site.address().port;
  const { key } = app.svc.configureDemo({ name: 'Берлога', deliveryRub: '100', servicePct: 0, origins: `localhost:${sitePort}`,
    menuText: 'Сеты | Мега-сет | 3800\nНапитки | Морс | 250' });
  app.svc.run('UPDATE restaurants SET tg_chat = ? WHERE key = ?', '555', key);
  site.on('request', (q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(SITE(sitePort, key, appPort)); });
  const siteUrl = `http://localhost:${sitePort}/`;

  let fails = 0;
  const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); if (!ok) fails++; };
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(siteUrl);
    const btn = page.getByRole('button', { name: 'Заказать вместе' });
    await btn.waitFor();
    const box = await btn.boundingBox();
    check('кнопка видна, несмотря на стили сайта (button{display:none})', !!box && box.height > 30 && box.height < 80, JSON.stringify(box));
    check('шрифт сайта не протёк в кнопку', (await btn.evaluate((e) => getComputedStyle(e).fontSize)) === '15px');
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/widget-1-site.png` : undefined, fullPage: false }).catch(() => {});

    await btn.click();
    const fr = page.frameLocator('iframe');
    await fr.getByRole('button', { name: 'В корзину: Мега-сет' }).waitFor();
    check('виджет открылся поверх сайта, меню из ключа', true);
    check('фоновая страница не прокручивается', (await page.evaluate(() => document.documentElement.style.overflow)) === 'hidden');
    await fr.getByRole('button', { name: 'В корзину: Мега-сет' }).click();
    await fr.getByRole('button', { name: /Моя корзина/ }).click();
    await fr.getByRole('button', { name: /Заказать компанией/ }).last().click();
    const ok1 = fr.getByRole('button', { name: 'Понятно, создать ссылку' });
    if (await ok1.count()) await ok1.click();
    await fr.locator('#f-name').fill('Олег');
    await fr.locator('#f-go').click();
    await fr.locator('.link-box code').waitFor();
    const invite = (await fr.locator('.link-box code').innerText()).trim();
    check('ссылка друзьям ведёт на сайт ресторана с ?go=', new RegExp(`^http://localhost:${sitePort}/\\?go=[A-Z0-9]{6}$`).test(invite), invite);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/widget-2-invite.png` : undefined }).catch(() => {});

    // Гость открывает ссылку друга: виджет сам открывается на общем заказе
    const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await guest.goto(invite);
    const gf = guest.frameLocator('iframe');
    await gf.locator('input').first().waitFor();
    check('гость по ?go= сразу попадает в общий заказ без нажатия кнопки', /Олег/.test(await gf.locator('body').innerText()));
    await gf.locator('input').first().fill('Аня');
    await gf.getByRole('button', { name: /Присоединиться|Войти|Продолжить/ }).first().click();
    await gf.getByRole('button', { name: 'Добавить: Морс' }).click();
    await guest.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/widget-3-guest.png` : undefined }).catch(() => {});

    // Хост: к оплате → телефон и адрес → заказ в очереди
    await fr.getByRole('button', { name: 'Перейти к меню' }).click();
    await fr.locator('[data-act="lock-open"]').click();
    await fr.getByRole('button', { name: 'Заблокировать и оплатить' }).click();
    await fr.locator('[data-act="pay-open"]').click();
    check('форма заказа просит телефон и адрес', (await fr.locator('#f-phone').count()) === 1 && (await fr.locator('#f-addr').count()) === 1);
    await fr.getByRole('button', { name: 'Отправить заказ' }).click();
    check('пустой телефон не пропускается', /Введите телефон/.test(await fr.locator('#pay-err').innerText()));
    await fr.locator('#f-phone').fill('+7 900 111-22-33');
    await fr.locator('#f-addr').fill('Казань, ул. Баумана 1, кв. 5');
    await fr.getByRole('button', { name: 'Отправить заказ' }).click();
    for (let i = 0; i < 100 && !app.svc.all('SELECT * FROM outbox').length; i++) await new Promise((r) => setTimeout(r, 50));
    const [row] = app.svc.all('SELECT * FROM outbox');
    check('заказ попал в очередь для Telegram с пометкой и составом', !!row && /Совместный заказ · 2 чел\./.test(row.text) && /Мега-сет/.test(row.text) && /Морс/.test(row.text) && /Баумана/.test(row.text), row && row.text);
    if (row) console.log('--- текст заказа ---\n' + row.text + '\n--------------------');

    // Закрытие
    // Esc сначала закрывает открытую шторку приложения, затем сам виджет
    for (let i = 0; i < 3 && (await page.evaluate(() => document.documentElement.style.overflow)) === 'hidden'; i++) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
    check('Esc закрывает виджет и возвращает прокрутку', (await page.evaluate(() => document.documentElement.style.overflow)) === '');
    check('нет ошибок в консоли страницы', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    app.close(); site.close();
  }
  console.log(fails ? `\nПровалено проверок: ${fails}` : '\nВсе проверки пройдены');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
