/* bench-controls.js — one control language for every simulator in the Nephrology POCUS Bench.

   Ahmed, 2026-10-06: "make it more responsive, more realistic; the circular knobs are hard to use on a
   laptop; unify the design branding."

   Every slider becomes a console fader, the way the touch panels of current point-of-care machines
   (Sonosite PX, Philips Lumify, Butterfly) present gain, depth and Doppler settings:
     - drag the cap, or click anywhere on the track to jump there;
     - the − and + keys step once per press and repeat (then speed up) while held;
     - arrow keys, Page Up/Down, Home and End work once the fader has focus;
     - the scroll wheel or trackpad adjusts it ONLY while it has focus, so the page still scrolls past it.

   The native <input type="range"> stays the control. Nothing is re-implemented: every bench's own
   "input" listener, every $("#id") lookup and every preset that writes r.value keeps working.

   Use: PBControls.enhance(root, { tone: "dark" | "page" | "hw" })
     "dark" = on a scanner console or screen; "page" = on a page card (takes the page's brand tokens);
     "hw" = the moulded hardware skin of the in-book simulators (inside .machine.hw, pbconsole.css).
   Safe to call repeatedly: a fader is only built once per input.                                       */
(function () {
  'use strict';
  if (window.PBControls) return;

  var CSS = [
    '.pbc{display:flex;align-items:center;gap:6px;min-width:0;width:100%;border-radius:9px}',
    '.pbc{--pbc-accent:#E58A98;--pbc-fill:#E58A98;--pbc-track:rgba(255,255,255,.13);--pbc-key:#262224;--pbc-key-on:#1A1718;--pbc-key-ink:#ECE5E4;--pbc-key-line:#3B3436;',
    '  --pbc-cap:linear-gradient(90deg,transparent calc(50% - 1px),#F4EDEC calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)),linear-gradient(180deg,#5B5254,#2B2627);--pbc-cap-line:#0B0A0A;--pbc-glow:rgba(229,138,152,.38)}',
    '.pbc.pbc-page{--pbc-accent:var(--accent,var(--teal,#8E2D3B));--pbc-fill:var(--accent,var(--teal,#8E2D3B));--pbc-track:var(--line,#CCB8BA);',
    '  --pbc-key:var(--surface,var(--card,#F5EBED));--pbc-key-on:var(--surface-2,var(--paper-2,#ECDADC));--pbc-key-ink:var(--ink-2,#4A3639);--pbc-key-line:var(--line,#CCB8BA);',
    '  --pbc-cap:linear-gradient(90deg,transparent calc(50% - 1px),var(--accent,var(--teal,#8E2D3B)) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)),linear-gradient(180deg,#FFFFFF,#E9DFE0);',
    '  --pbc-cap-line:var(--line,#CCB8BA);--pbc-glow:color-mix(in srgb,var(--accent,var(--teal,#8E2D3B)) 28%,transparent)}',
    '.pbc-k{flex:0 0 auto;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font:600 18px/1 system-ui,sans-serif;cursor:pointer;',
    '  -webkit-user-select:none;user-select:none;touch-action:manipulation;background:var(--pbc-key);color:var(--pbc-key-ink);border:1px solid var(--pbc-key-line);',
    '  box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 2px 3px rgba(0,0,0,.28);transition:border-color .12s,background-color .12s}',
    '.pbc-k:hover{border-color:var(--pbc-accent)}',
    '.pbc-k.on{background:var(--pbc-key-on);box-shadow:inset 0 2px 4px rgba(0,0,0,.35);transform:translateY(1px)}',
    '.pbc-k.off{opacity:.38}',
    'input[type=range].pbc-r{-webkit-appearance:none;appearance:none;flex:1 1 auto;min-width:64px;width:auto;max-width:none;height:34px;margin:0;padding:0;',
    '  background:transparent;cursor:pointer;accent-color:var(--pbc-accent);position:static;opacity:1;pointer-events:auto}',
    'input[type=range].pbc-r:focus{outline:none}',
    'input[type=range].pbc-r::-webkit-slider-runnable-track{height:6px;border-radius:3px;box-shadow:inset 0 1px 2px rgba(0,0,0,.35);',
    '  background:linear-gradient(90deg,var(--pbc-track) 0 var(--pa,0%),var(--pbc-fill) var(--pa,0%) var(--pb,50%),var(--pbc-track) var(--pb,50%) 100%)}',
    'input[type=range].pbc-r::-moz-range-track{height:6px;border-radius:3px;box-shadow:inset 0 1px 2px rgba(0,0,0,.35);',
    '  background:linear-gradient(90deg,var(--pbc-track) 0 var(--pa,0%),var(--pbc-fill) var(--pa,0%) var(--pb,50%),var(--pbc-track) var(--pb,50%) 100%)}',
    'input[type=range].pbc-r::-moz-range-progress{background:transparent}',
    'input[type=range].pbc-r::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:28px;margin-top:-11px;border-radius:5px;background:var(--pbc-cap);',
    '  border:1px solid var(--pbc-cap-line);box-shadow:0 2px 5px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.3);transition:box-shadow .12s}',
    'input[type=range].pbc-r::-moz-range-thumb{width:18px;height:28px;border-radius:5px;background:var(--pbc-cap);border:1px solid var(--pbc-cap-line);',
    '  box-shadow:0 2px 5px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.3)}',
    'input[type=range].pbc-r:hover::-webkit-slider-thumb,input[type=range].pbc-r:active::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--pbc-glow),0 2px 5px rgba(0,0,0,.45)}',
    'input[type=range].pbc-r:hover::-moz-range-thumb,input[type=range].pbc-r:active::-moz-range-thumb{box-shadow:0 0 0 4px var(--pbc-glow),0 2px 5px rgba(0,0,0,.45)}',
    '.pbc:has(.pbc-r:focus-visible){outline:2px solid var(--pbc-accent);outline-offset:3px}',
    'input[type=range].pbc-r:disabled{cursor:default;opacity:.45}',
    /* "hw" = the hardware skin of the in-book simulators (pbconsole.css, .machine.hw supplies the --hw-* tokens):
       a sunken groove, a lit rose run, a moulded cap with grip lines, small raised keys that press in */
    '.pbc.pbc-hw{--pbc-accent:var(--hw-lit,#E58A98);--pbc-fill:var(--hw-lit,#E58A98);--pbc-track:var(--hw-recess,#d3dae4);--pbc-glow:rgba(229,138,152,.4);',
    '  --pbc-cap:linear-gradient(90deg,transparent calc(50% - 1px),var(--hw-accent,#8E2D3B) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)),',
    '  repeating-linear-gradient(0deg,rgba(0,0,0,.07) 0 1px,transparent 1px 3px),linear-gradient(180deg,var(--hw-key-hi,#f2f5f9),var(--hw-key-lo,#d9dfe7))}',
    '.pbc-hw .pbc-k{width:32px;height:32px;border-radius:9px;color:var(--hw-ink,#2d3436);border:1px solid var(--hw-rim,rgba(255,255,255,.65));',
    '  background:linear-gradient(145deg,var(--hw-key-hi,#f2f5f9),var(--hw-key-lo,#d9dfe7));box-shadow:var(--hw-sh-mini,2px 2px 5px #babecc,-2px -2px 5px #fff);',
    '  transition:transform .2s cubic-bezier(.175,.885,.32,1.275),box-shadow .2s}',
    '.pbc-hw .pbc-k:hover{border-color:var(--hw-rim,rgba(255,255,255,.65));transform:translateY(-1px)}',
    '.pbc-hw .pbc-k.on{background:linear-gradient(145deg,var(--hw-key-hi,#f2f5f9),var(--hw-key-lo,#d9dfe7));box-shadow:var(--hw-sh-press,inset 4px 4px 8px #babecc,inset -4px -4px 8px #fff);transform:translateY(1px)}',
    '.pbc-hw input[type=range].pbc-r::-webkit-slider-runnable-track{height:8px;border-radius:4px;box-shadow:inset 2px 2px 4px rgba(0,0,0,.3),inset -1px -1px 2px rgba(255,255,255,.35)}',
    '.pbc-hw input[type=range].pbc-r::-moz-range-track{height:8px;border-radius:4px;box-shadow:inset 2px 2px 4px rgba(0,0,0,.3),inset -1px -1px 2px rgba(255,255,255,.35)}',
    '.pbc-hw input[type=range].pbc-r::-webkit-slider-thumb{width:20px;height:30px;margin-top:-11px;border-radius:6px;border:1px solid var(--hw-rim,rgba(255,255,255,.65));',
    '  box-shadow:3px 3px 6px var(--hw-edge,#babecc),-2px -2px 5px var(--hw-hi,#fff),inset 0 1px 0 rgba(255,255,255,.6)}',
    '.pbc-hw input[type=range].pbc-r::-moz-range-thumb{width:20px;height:30px;border-radius:6px;border:1px solid var(--hw-rim,rgba(255,255,255,.65));',
    '  box-shadow:3px 3px 6px var(--hw-edge,#babecc),-2px -2px 5px var(--hw-hi,#fff),inset 0 1px 0 rgba(255,255,255,.6)}',
    '.pbc-hw input[type=range].pbc-r:hover::-webkit-slider-thumb,.pbc-hw input[type=range].pbc-r:active::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--pbc-glow),3px 3px 6px var(--hw-edge,#babecc)}',
    '.pbc-hw input[type=range].pbc-r:hover::-moz-range-thumb,.pbc-hw input[type=range].pbc-r:active::-moz-range-thumb{box-shadow:0 0 0 4px var(--pbc-glow),3px 3px 6px var(--hw-edge,#babecc)}',
    '@media (pointer:coarse){.pbc-k,.pbc-hw .pbc-k{width:38px;height:38px}input[type=range].pbc-r{height:44px}}',
    '@media (prefers-reduced-motion:reduce){.pbc-k,input[type=range].pbc-r::-webkit-slider-thumb{transition:none}}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('pbc-css')) return;
    var s = document.createElement('style'); s.id = 'pbc-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var VAL = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function lim(r) { var mn = num(r.min, 0), mx = num(r.max, 100); return [mn, mx > mn ? mx : mn + 1]; }

  /* The lit part of the track runs from zero for a range that straddles zero (tilt, offset),
     and from the minimum otherwise, the way a bipolar control is drawn on a console. */
  function paint(r) {
    var m = lim(r), v = num(VAL.get.call(r), m[0]), f = function (x) { return Math.max(0, Math.min(100, (x - m[0]) / (m[1] - m[0]) * 100)); };
    var z = (m[0] < 0 && m[1] > 0) ? f(0) : 0, p = f(v);
    r.style.setProperty('--pa', Math.min(z, p).toFixed(2) + '%');
    r.style.setProperty('--pb', Math.max(z, p).toFixed(2) + '%');
    var w = r.__pbc; if (w) { w.dn.classList.toggle('off', v <= m[0]); w.up.classList.toggle('off', v >= m[1]); }
  }

  function stepOf(r) { var m = lim(r); return r.step === 'any' ? (m[1] - m[0]) / 100 : num(r.step, 1) || 1; }

  function stepBy(r, n) {
    if (r.disabled) return false;
    var m = lim(r), st = stepOf(r), v = num(r.value, m[0]) + n * st;
    v = m[0] + Math.round((v - m[0]) / st) * st;
    v = Math.max(m[0], Math.min(m[1], +v.toFixed(6)));
    if (v === num(r.value, NaN)) return false;
    r.value = v;
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function key(sym, dir, r, name) {
    var b = document.createElement('span');
    b.className = 'pbc-k'; b.textContent = sym; b.setAttribute('aria-hidden', 'true'); b.title = name;
    var t1 = null, t2 = null, moved = false;
    function stop() {
      if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; b.classList.remove('on');
      if (moved) r.dispatchEvent(new Event('change', { bubbles: true })); moved = false;
    }
    b.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault(); stop();
      try { r.focus({ preventScroll: true }); } catch (_) {}
      b.classList.add('on');
      moved = stepBy(r, dir) || moved;
      var k = 0;
      t1 = setTimeout(function () {
        t2 = setInterval(function () { k++; if (stepBy(r, dir * (k > 20 ? 4 : k > 10 ? 2 : 1))) moved = true; else stop(); }, 65);
      }, 380);
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { b.addEventListener(t, stop); });
    /* the key sits inside the control's <label>: stop the label from forwarding the click */
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    return b;
  }

  function build(r, tone) {
    if (r.__pbc || r.hasAttribute('data-pbc-skip')) return;
    var w = document.createElement('span');
    w.className = 'pbc' + (tone === 'page' ? ' pbc-page' : tone === 'hw' ? ' pbc-hw' : '');
    var lab = r.closest('label'), sp = lab && lab.querySelector('span:not(.pbc-k)');
    var name = (r.getAttribute('aria-label') || (sp && sp.textContent) || (r.id && document.querySelector('label[for="' + r.id + '"]') || {}).textContent || 'value').trim().slice(0, 40);
    var dn = key('−', -1, r, 'Lower ' + name.toLowerCase() + ' (hold to keep going)');
    var up = key('+', 1, r, 'Raise ' + name.toLowerCase() + ' (hold to keep going)');
    r.parentNode.insertBefore(w, r);
    w.appendChild(dn); w.appendChild(r); w.appendChild(up);
    r.classList.add('pbc-r');
    r.__pbc = { w: w, dn: dn, up: up };
    /* presets write r.value without an event: repaint on every write, and on min/max changes */
    try {
      Object.defineProperty(r, 'value', { configurable: true, get: function () { return VAL.get.call(this); },
        set: function (v) { VAL.set.call(this, v); paint(this); } });
    } catch (_) {}
    r.addEventListener('input', function () { paint(r); });
    r.addEventListener('change', function () { paint(r); });
    try { new MutationObserver(function () { paint(r); }).observe(r, { attributes: true, attributeFilter: ['min', 'max', 'value', 'step', 'disabled'] }); } catch (_) {}
    /* wheel and trackpad: only while this fader has focus, so scrolling the page is never captured */
    var acc = 0;
    w.addEventListener('wheel', function (e) {
      if (document.activeElement !== r || r.disabled) return;
      e.preventDefault();
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
      acc += d * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1);
      var n = acc > 0 ? Math.floor(acc / 36) : Math.ceil(acc / 36);
      if (n) { acc -= n * 36; if (stepBy(r, n)) r.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { passive: false });
    r.addEventListener('blur', function () { acc = 0; });
    paint(r);
  }

  function enhance(root, opt) {
    injectCss();
    opt = opt || {};
    root = root || document;
    var list = root.querySelectorAll ? root.querySelectorAll('input[type=range]') : [];
    for (var i = 0; i < list.length; i++) {
      var t = typeof opt.tone === 'function' ? opt.tone(list[i]) : opt.tone;
      build(list[i], t || 'dark');
    }
  }

  window.PBControls = { enhance: enhance, step: stepBy, paint: paint };
})();
