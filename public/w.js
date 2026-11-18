/* Виджет «Совместный заказ». Подключение одной строкой:
   <script src="https://ВАШ-ДОМЕН/w.js" data-key="КЛЮЧ" defer></script>
   Необязательно: data-label="Заказать вместе", data-color="#e4572e", data-pos="left".
   Весь интерфейс живёт во фрейме с нашего домена, кнопка и оболочка в Shadow DOM:
   стили сайта на виджет и виджета на сайт не влияют. */
(function () {
  'use strict';
  var s = document.currentScript;
  if (!s || window.__goWidget) return;
  var key = s.getAttribute('data-key');
  if (!key) return console.warn('[go-widget] нужен data-key');
  window.__goWidget = true;
  var base = new URL(s.src, location.href).origin;
  var label = s.getAttribute('data-label') || 'Заказать вместе';
  var color = /^#[0-9a-f]{3,8}$/i.test(s.getAttribute('data-color') || '') ? s.getAttribute('data-color') : '#e4572e';
  var left = s.getAttribute('data-pos') === 'left';

  function init() {
    var host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '*{box-sizing:border-box}' +
      '.b{position:fixed;bottom:max(16px,env(safe-area-inset-bottom));' + (left ? 'left' : 'right') + ':16px;border:0;border-radius:999px;' +
      'padding:13px 20px;font:600 15px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:' + color + ';' +
      'box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}' +
      '.b:focus-visible,.x:focus-visible{outline:3px solid #fff;outline-offset:-3px;box-shadow:0 0 0 5px #000}' +
      '.o{position:fixed;inset:0;display:none;background:rgba(0,0,0,.5)}.o.on{display:block}' +
      '.f{position:absolute;top:48px;right:0;width:100%;height:calc(100% - 48px);max-width:440px;border:0;background:#fff}' +
      '.h{position:absolute;top:0;right:0;width:100%;max-width:440px;height:48px;background:#111;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 4px 0 16px;font:600 15px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.x{width:44px;height:44px;border:0;background:transparent;color:#fff;font-size:28px;line-height:1;cursor:pointer}' +
      '</style>' +
      '<button class="b" type="button" aria-haspopup="dialog"></button>' +
      '<div class="o" role="dialog" aria-modal="true" aria-label="' + label.replace(/"/g, '') + '">' +
      '<div class="h"><span class="t"></span><button class="x" type="button" aria-label="Закрыть">×</button></div>' +
      '<iframe class="f" title="' + label.replace(/"/g, '') + '" allow="clipboard-write; web-share; screen-wake-lock"></iframe></div>';
    var btn = root.querySelector('.b'), ov = root.querySelector('.o'), fr = root.querySelector('iframe'), x = root.querySelector('.x');
    btn.textContent = label;
    root.querySelector('.t').textContent = label;
    var prevOverflow = '';

    function open(code) {
      var site = location.origin + location.pathname;
      fr.src = code ? base + '/j/' + encodeURIComponent(code) + '?s=' + encodeURIComponent(site)
                    : base + '/embed?k=' + encodeURIComponent(key) + '&s=' + encodeURIComponent(site);
      ov.classList.add('on');
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      x.focus();
    }
    function close() {
      ov.classList.remove('on');
      fr.src = 'about:blank';
      document.documentElement.style.overflow = prevOverflow;
      btn.focus();
    }
    btn.addEventListener('click', function () { open(null); });
    x.addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('on')) close(); });
    // Esc, нажатый внутри фрейма, до страницы не доходит: фрейм сам просит закрыть виджет.
    window.addEventListener('message', function (e) {
      if (e.origin === base && e.source === fr.contentWindow && e.data && e.data.goWidget === 'close' && ov.classList.contains('on')) close();
    });
    document.body.appendChild(host);

    // Гость пришёл по ссылке друга: https://сайт/?go=КОД — сразу открываем общий заказ.
    var go = new URLSearchParams(location.search).get('go');
    if (go && /^[A-Za-z0-9]{6}$/.test(go)) open(go);
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
