'use strict';
// Проверка QR-кодировщика настоящим декодером (OpenCV). Если cv2 нет — тест пропускается.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const QR = require('../public/qr.js');

const hasCv2 = spawnSync('python3', ['-I', '-c', 'import cv2']).status === 0;

function toPgm(modules, scale = 8, margin = 4) {
  const n = modules.length + margin * 2;
  const px = n * scale;
  const header = Buffer.from(`P5\n${px} ${px}\n255\n`);
  const body = Buffer.alloc(px * px, 255);
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) body[((y + margin) * scale + dy) * px + (x + margin) * scale + dx] = 0;
      }
    }
  }
  return Buffer.concat([header, body]);
}

function decode(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  const file = path.join(dir, 'q.pgm');
  fs.writeFileSync(file, toPgm(QR.encode(text).modules));
  const py = 'import cv2,sys\nimg=cv2.imread(sys.argv[1],0)\nv,_,_=cv2.QRCodeDetector().detectAndDecode(img)\nsys.stdout.write(v)';
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout;
}

test('QR: выбор версии и ограничения', () => {
  assert.strictEqual(QR.encode('http://localhost:3000/j/ABC234').version, 3);
  assert.ok(QR.encode('x'.repeat(213)).version === 10);
  assert.throws(() => QR.encode('x'.repeat(214)), RangeError);
  assert.match(QR.svg('hello'), /^<svg /);
});

test('QR декодируется OpenCV на всех версиях 1–10', { skip: !hasCv2 && 'нет python3 + cv2' }, () => {
  const samples = [
    'A',
    'http://localhost:3000/j/ABC234',
    'https://food.example.com/j/K7M2QX',
    'https://food.example.com/j/K7M2QX?utm_source=qr&utm_campaign=group-order',
    'https://food.example.com/j/K7M2QX?utm_source=qr&utm_campaign=group-order&ref=host-12345&lang=ru&x=' + 'a'.repeat(20),
    'Заказ вместе: https://food.example.com/j/K7M2QX',
    'u'.repeat(110),
    'v'.repeat(150),
    'w'.repeat(180),
    'z'.repeat(213),
  ];
  const seen = new Set();
  for (const s of samples) {
    seen.add(QR.encode(s).version);
    assert.strictEqual(decode(s), s, `не декодируется: версия ${QR.encode(s).version}, ${s.length} симв.`);
  }
  assert.ok(seen.size >= 8, `покрыто версий: ${[...seen].sort((a, b) => a - b)}`);
});
