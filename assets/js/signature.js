/**
 * The signature pad: draw with a finger, stylus or mouse on a canvas. Loaded
 * on demand by assets/js/proposal.js. No dependencies, no inline anything.
 *
 *   attachPad(canvas, { onChange }) → { isEmpty(), clear(), toPngBase64() }
 *
 * The stroke colour is the canvas's own CSS `color` (a token), so nothing is
 * hard-coded. The export is a fixed 600 × 180 PNG on white, whatever the
 * screen, so every stored signature is the same size and well under the
 * server's 200 KB limit. A pad cannot be used from a keyboard: the typed
 * signature beside it is the accessible route.
 */
const OUT_W = 600;
const OUT_H = 180;

export function attachPad(canvas, { onChange = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let length = 0;

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * ratio);
    const h = Math.round(r.height * ratio);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    redraw();
  };
  const style = (c, scale) => {
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = 2.4 * scale;
    c.strokeStyle = getComputedStyle(canvas).color;
  };
  // Points are kept in 0..1 of the pad, so a resize or the export redraws them exactly.
  const draw = (c, w, h, scale) => {
    style(c, scale);
    for (const s of strokes) {
      if (s.length === 1) { c.beginPath(); c.arc(s[0][0] * w, s[0][1] * h, 1.4 * scale, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill(); continue; }
      c.beginPath();
      c.moveTo(s[0][0] * w, s[0][1] * h);
      for (let i = 1; i < s.length - 1; i += 1) {
        const mx = ((s[i][0] + s[i + 1][0]) / 2) * w;
        const my = ((s[i][1] + s[i + 1][1]) / 2) * h;
        c.quadraticCurveTo(s[i][0] * w, s[i][1] * h, mx, my);
      }
      const last = s[s.length - 1];
      c.lineTo(last[0] * w, last[1] * h);
      c.stroke();
    }
  };
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height, Math.min(window.devicePixelRatio || 1, 2));
  }
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    fit();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
      const p = point(ev);
      const prev = current[current.length - 1];
      length += Math.hypot((p[0] - prev[0]) * r.width, (p[1] - prev[1]) * r.height);
      current.push(p);
    }
    redraw();
  });
  const end = () => { if (current) { current = null; onChange(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);
  fit();

  return {
    // A tap or two is not a signature: it needs some ink.
    isEmpty: () => length < 40,
    clear() { strokes.length = 0; length = 0; current = null; redraw(); onChange(); },
    toPngBase64() {
      const out = document.createElement('canvas');
      out.width = OUT_W;
      out.height = OUT_H;
      const c = out.getContext('2d');
      c.fillStyle = getComputedStyle(canvas).backgroundColor || 'white';
      c.fillRect(0, 0, OUT_W, OUT_H);
      draw(c, OUT_W, OUT_H, 1.6);
      return out.toDataURL('image/png').split(',')[1];
    },
  };
}
