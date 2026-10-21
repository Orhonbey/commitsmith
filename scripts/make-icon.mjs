// Generates media/icon.png (128x128): sparkle + branch glyph. Built-ins only.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const W = 128, S = 4; // supersample
const N = W * S;
const buf = new Float32Array(N * N * 4);
const set = (x, y, c) => { const i = (y * N + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 1; };
const inRound = (x, y, r) => { const cx = Math.min(Math.max(x, r), N - 1 - r), cy = Math.min(Math.max(y, r), N - 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
const bg = [31, 41, 85], fg = [255, 255, 255], accent = [255, 200, 60], green = [90, 220, 170];
const seg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const u = S; // 1 px at 128 scale
const circ = (px, py, cx, cy, r) => Math.hypot(px - cx * u, py - cy * u) <= r * u;
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  if (!inRound(x, y, 24 * u)) continue;
  let c = bg;
  // branch: main line left, fork to the right
  const w = 4.5 * u;
  if (seg(x, y, 38 * u, 36 * u, 38 * u, 100 * u) <= w) c = fg;
  if (seg(x, y, 38 * u, 84 * u, 66 * u, 64 * u) <= w) c = fg;
  for (const [cx, cy, col] of [[38, 36, fg], [38, 100, fg], [66, 64, green]]) if (circ(x, y, cx, cy, 10)) c = col;
  if (circ(x, y, 38, 36, 4.5) || circ(x, y, 38, 100, 4.5) || circ(x, y, 66, 64, 4.5)) c = bg;
  // 4-point sparkle at (92,44)
  const sx = (x / u - 92), sy = (y / u - 44);
  if (Math.abs(sx) ** 0.6 + Math.abs(sy) ** 0.6 <= 20 ** 0.6) c = accent;
  const sx2 = (x / u - 104), sy2 = (y / u - 82);
  if (Math.abs(sx2) ** 0.6 + Math.abs(sy2) ** 0.6 <= 10 ** 0.6) c = accent;
  set(x, y, c);
}
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const k = ((y * S + j) * N + x * S + i) * 4; const al = buf[k + 3]; r += buf[k] * al; g += buf[k + 1] * al; b += buf[k + 2] * al; a += al; }
    const o = y * (W * 4 + 1) + 1 + x * 4;
    if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); raw[o + 3] = Math.round((a / (S * S)) * 255); }
  }
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync('media/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
