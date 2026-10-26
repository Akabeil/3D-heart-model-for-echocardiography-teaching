/*! sim-engine.js — PBSim 1.0 · shared 3D probe-and-plane ultrasound simulator engine for the Nephrology POCUS Bench.
 *  One classic script, exposes window.PBSim. The 2D image, coach and scoring start at once; the 3D pane starts when three.js r160 has loaded.
 *  Loading (2026-10-18, v1.1): three.js is the ES-module build, fetched with a dynamic import() through the page's import map
 *    { "three": ".../three@0.160.0/build/three.module.js", "three/addons/": ".../three@0.160.0/examples/jsm/" }
 *  so GLTFLoader (examples/jsm, imports 'three') shares the SAME module instance: one copy of three, instanceof checks hold.
 *  The namespace is copied into a plain object (window.THREE) because module namespaces are frozen. A page that still loads the
 *  old UMD three.min.js keeps working (its global is used), but then GLTF anatomy models are skipped rather than mixing two copies.
 *  If three or a model fails to load, the trainer runs exactly as before (no 3D, or no anatomy overlay). No WebAssembly is used:
 *  the anatomy models are plain glTF (KHR_mesh_quantization only), decompressed ahead of time.
 *  Machine UI (v1.1): Sonosite / GE Venue-style cart console (.pbc classes, shared with pbconsole.css in the in-page benches).
 *  Anatomy is procedural: the sim supplies tissueAt(x,y,z,t,S) -> tissue id. See ENGINE-README.md.
 *  World space (mm): x = patient LEFT, y = SUPERIOR (head), z = ANTERIOR. Right-handed.
 *  Pose: O = probe face centre on the skin, n = beam axis into the patient, u = lateral axis toward the index marker, N = n x u.
 */
(function () {
'use strict';
/* glb models are published as base64 in m3d/<name>.glb.js (the artifact host does not serve .glb): load the script once, decode, parse */
function pbLoadGLB(url, loader, onLoad, onErr) {
  var n = String(url).replace(/^.*\//, '').replace(/\.glb$/, '');
  function go() { try { var s = atob(window.PBGLB[n]), L = s.length, u = new Uint8Array(L); for (var i = 0; i < L; i++) u[i] = s.charCodeAt(i); loader.parse(u.buffer, '', onLoad, onErr); } catch (e) { if (onErr) onErr(e); } }
  if (window.PBGLB && window.PBGLB[n]) { go(); return; }
  var sc = document.createElement('script'); sc.src = String(url).replace(/\.glb$/, '.glb.js'); sc.onload = go; sc.onerror = function (e) { if (onErr) onErr(e); }; document.head.appendChild(sc);
}
var D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* ------------------------------------------------------------------ vector helpers (arrays [x,y,z]) */
var add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
var sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
var mul = function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; };
var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
var len = function (a) { return Math.hypot(a[0], a[1], a[2]); };
var nrm = function (a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
var rot = function (v, ax, ang) { ax = nrm(ax); var c = Math.cos(ang), s = Math.sin(ang); return add(add(mul(v, c), mul(cross(ax, v), s)), mul(ax, dot(ax, v) * (1 - c))); };
var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
var V = { add: add, sub: sub, mul: mul, dot: dot, cross: cross, len: len, nrm: nrm, rot: rot, clamp: clamp };

/* ------------------------------------------------------------------ three.js loader (one shared promise per page) */
var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
var threeP = null;
function loadThree() {
  if (threeP) return threeP;
  if (window.THREE && window.THREE.WebGLRenderer && !window.THREE.__pbModule) { threeP = Promise.resolve(window.THREE); return threeP; }   // legacy UMD global: 3D yes, GLTF no
  var dyn = function (u) { try { return import(u); } catch (e) { return Promise.reject(e); } };
  var wrap = function (ns) { var T = Object.assign({}, ns); T.__pbModule = true; window.THREE = T; return T; };
  threeP = dyn('three').then(function (ns) {                                   // bare specifier: resolved by the page's import map
    var T = wrap(ns);
    return dyn('three/addons/loaders/GLTFLoader.js').then(function (m) { T.GLTFLoader = m.GLTFLoader; return T; }, function () { return T; });
  }, function () { return dyn(THREE_URL).then(wrap); })                          // no import map: 3D still works, anatomy models are skipped
    .catch(function () { return null; });
  return threeP;
}

/* ------------------------------------------------------------------ geometry helpers */
/* Orthonormal frame from a long axis and a hint for the second axis: {L, M, T} with T = L x M. */
function frame(axis, hint) {
  var L = nrm(axis), M = sub(hint, mul(L, dot(hint, L)));
  if (len(M) < 1e-4) M = sub([1, 0, 0], mul(L, L[0]));
  M = nrm(M); return { L: L, M: M, T: cross(L, M) };
}
/* Elliptic-cylinder skin surface (torso, limb, neck). opts: {p0, p1, ra, rb, e1}
 * p0 -> p1 is the axis (p1 end = the "reference" direction for rot = 0, e.g. the head), ra along e1, rb along axis x e1.
 * Returns {project(p) -> {p, n (inward normal), ref}, depth(x,y,z) (mm below the skin, <0 outside), mesh(THREE, material)}. */
function cylinder(o) {
  var p0 = o.p0, A = nrm(sub(o.p1, p0)), H = len(sub(o.p1, p0));
  var E1 = o.e1 || [1, 0, 0]; E1 = nrm(sub(E1, mul(A, dot(E1, A)))); var E2 = cross(A, E1), ra = o.ra, rb = o.rb, m = o.margin == null ? 10 : o.margin;
  function at(h, f) { var c = Math.cos(f), s = Math.sin(f); return add(add(p0, mul(A, h)), add(mul(E1, ra * c), mul(E2, rb * s))); }
  return {
    axis: A, ref: A,
    project: function (p) {
      var q = sub(p, p0), h = clamp(dot(q, A), m, H - m), f = Math.atan2(dot(q, E2) / rb, dot(q, E1) / ra), c = Math.cos(f), s = Math.sin(f);
      return { p: at(h, f), n: mul(nrm(add(mul(E1, c / ra), mul(E2, s / rb))), -1), ref: A };
    },
    /* skin point reached from an inside point p travelling along dir (the place to put the probe to look back along -dir) */
    hit: function (p, dir) {
      var q = sub(p, p0), c1 = dot(q, E1) / ra, c2 = dot(q, E2) / rb, d1 = dot(dir, E1) / ra, d2 = dot(dir, E2) / rb, A2 = d1 * d1 + d2 * d2, B = c1 * d1 + c2 * d2, C = c1 * c1 + c2 * c2 - 1;
      if (A2 < 1e-12) return this.project(p).p; var t = (-B + Math.sqrt(Math.max(0, B * B - A2 * C))) / A2; return this.project(add(p, mul(dir, t))).p;
    },
    depth: function (x, y, z) {
      var qx = x - p0[0], qy = y - p0[1], qz = z - p0[2], c1 = qx * E1[0] + qy * E1[1] + qz * E1[2], c2 = qx * E2[0] + qy * E2[1] + qz * E2[2], h = qx * A[0] + qy * A[1] + qz * A[2];
      if (h < 0 || h > H) return -1;
      var rho = Math.sqrt(c1 * c1 / (ra * ra) + c2 * c2 / (rb * rb)); if (rho < 1e-6) return Math.min(ra, rb);
      return Math.hypot(c1, c2) * (1 / rho - 1);
    },
    mesh: function (THREE, material) {
      var nu = 48, nv = 20, pos = [], idx = [], i, j;
      for (j = 0; j <= nv; j++) for (i = 0; i <= nu; i++) { var P = at(H * j / nv, 2 * Math.PI * i / nu); pos.push(P[0], P[1], P[2]); }
      for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) { var a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
      var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      return new THREE.Mesh(g, material);
    }
  };
}
/* Flat skin (phantom block, or a limb treated as flat): opts {p0, n (inward normal), ref}. */
function plane(o) {
  var n = nrm(o.n), ref = o.ref || [0, 1, 0];
  return {
    ref: ref,
    project: function (p) { var d = dot(sub(p, o.p0), n); return { p: sub(p, mul(n, d)), n: n, ref: ref }; },
    hit: function (p, dir) { var dn = dot(dir, n), d = dot(sub(p, o.p0), n); return dn > -1e-9 ? sub(p, mul(n, d)) : add(p, mul(dir, -d / dn)); },
    depth: function (x, y, z) { return (x - o.p0[0]) * n[0] + (y - o.p0[1]) * n[1] + (z - o.p0[2]) * n[2]; },
    mesh: function (THREE, material, size) { var f = frame(ref, cross(n, ref)), s = size || 200, P = function (a, b) { return add(o.p0, add(mul(f.L, a), mul(f.M, b))); }, q = [P(-s, -s), P(s, -s), P(s, s), P(-s, s)], pos = []; q.forEach(function (v) { pos.push(v[0], v[1], v[2]); }); var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals(); return new THREE.Mesh(g, material); }
  };
}
/* cheap deterministic lattice hash, 0..1 */
function hash3(i, j, k) { var h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
/* waveform helpers (phase 0..1 of the cardiac cycle) for flowAt */
var wave = {
  arterial: function (ph, psv, edv) { ph -= Math.floor(ph); return ph < 0.1 ? edv + (psv - edv) * Math.sin(ph / 0.1 * Math.PI / 2) : edv + (psv - edv) * Math.exp(-(ph - 0.1) / 0.25); },
  venous: function (ph, mean, puls) { ph -= Math.floor(ph); return mean * (1 + (puls || 0) * Math.sin(2 * Math.PI * ph)); }
};
function tissueIds(list) { var m = {}; list.forEach(function (t, i) { m[t.key] = i; }); return m; }

/* ------------------------------------------------------------------ anatomy kit: helpers page configs use to pose glTF parts in sim space */
function eig3(A) {                        // symmetric 3x3 (Jacobi, Numerical Recipes rotation): eigenvalues desc with unit eigenvectors
  var a = [A[0].slice(), A[1].slice(), A[2].slice()], Vv = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sw, p, q, k;
  for (sw = 0; sw < 40; sw++) {
    if (a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2] < 1e-18) break;
    for (p = 0; p < 2; p++) for (q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      var th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
      for (k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s2 * akq; a[k][q] = s2 * akp + c * akq; }
      for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s2 * aqk; a[q][k] = s2 * apk + c * aqk; }
      for (k = 0; k < 3; k++) { var vkp = Vv[k][p], vkq = Vv[k][q]; Vv[k][p] = c * vkp - s2 * vkq; Vv[k][q] = s2 * vkp + c * vkq; }
    }
  }
  return [0, 1, 2].map(function (i) { return { val: a[i][i], vec: [Vv[0][i], Vv[1][i], Vv[2][i]] }; }).sort(function (x, y) { return y.val - x.val; });
}
function anatKit(T3, root, grp) {
  var inv = function () { root.updateMatrixWorld(true); return new T3.Matrix4().copy(root.matrixWorld).invert(); };
  var K = {
    /* move a mesh under the anatomy group keeping its place; userData.base = its matrix in sim (root) space */
    adopt: function (mesh) { var iv = inv(); mesh.updateMatrixWorld(true); var M = new T3.Matrix4().multiplyMatrices(iv, mesh.matrixWorld); if (mesh.parent) mesh.parent.remove(mesh); grp.add(mesh); mesh.matrixAutoUpdate = false; mesh.matrix.copy(M); mesh.userData.base = M.clone(); mesh.matrixWorldNeedsUpdate = true; return mesh; },
    /* sim-space vertices of adopted meshes (every `step`-th vertex) */
    points: function (meshes, step) { var out = [], v = new T3.Vector3(); meshes.forEach(function (m) { var pa = m.geometry.attributes.position, M = m.userData.base || m.matrix; for (var i = 0; i < pa.count; i += (step || 1)) { v.fromBufferAttribute(pa, i).applyMatrix4(M); out.push([v.x, v.y, v.z]); } }); return out; },
    centroid: function (pts) { var c = [0, 0, 0]; pts.forEach(function (p) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }); return mul(c, 1 / (pts.length || 1)); },
    /* principal frame of a point set: e[0] longest axis; box centre c and half-extents h along e */
    pca: function (pts) {
      var c = K.centroid(pts), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      pts.forEach(function (p) { var d = sub(p, c); for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; });
      var E = eig3(C).map(function (x) { return nrm(x.vec); }), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      pts.forEach(function (p) { var d = sub(p, c); for (var i = 0; i < 3; i++) { var u = dot(d, E[i]); if (u < lo[i]) lo[i] = u; if (u > hi[i]) hi[i] = u; } });
      var cb = c; for (var i = 0; i < 3; i++) cb = add(cb, mul(E[i], (lo[i] + hi[i]) / 2));
      return { c: cb, e: E, h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
    },
    /* matrix taking sim space to unit coordinates of a frame {c, e:[e1,e2,e3], h:[a,b,c]} */
    toUnit: function (f) { var R = new T3.Matrix4().makeBasis(new T3.Vector3().fromArray(f.e[0]), new T3.Vector3().fromArray(f.e[1]), new T3.Vector3().fromArray(f.e[2])).transpose(); return new T3.Matrix4().makeScale(1 / f.h[0], 1 / f.h[1], 1 / f.h[2]).multiply(R).multiply(new T3.Matrix4().makeTranslation(-f.c[0], -f.c[1], -f.c[2])); },
    /* matrix taking unit coordinates to sim space: centre C, axes L, M, T (unit) with semi-axes a, b, c */
    fromUnit: function (C, L, M, T, a, b, c) { return new T3.Matrix4().makeBasis(new T3.Vector3().fromArray(mul(L, a)), new T3.Vector3().fromArray(mul(M, b)), new T3.Vector3().fromArray(mul(T, c))).setPosition(C[0], C[1], C[2]); },
    /* bind meshes to a unit frame once; then place(mesh, W) sets W * (unit-from-base) */
    bind: function (meshes, U) { meshes.forEach(function (m) { m.userData.norm = new T3.Matrix4().multiplyMatrices(U, m.userData.base); }); },
    place: function (mesh, W) { mesh.matrix.multiplyMatrices(W, mesh.userData.norm || mesh.userData.base); mesh.matrixWorldNeedsUpdate = true; },
    shift: function (mesh, d) { mesh.matrix.copy(mesh.userData.base); mesh.matrix.premultiply(new T3.Matrix4().makeTranslation(d[0], d[1], d[2])); mesh.matrixWorldNeedsUpdate = true; },
    axisBox: function (meshes) { var pts = K.points(meshes, 3), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; pts.forEach(function (p) { for (var i = 0; i < 3; i++) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; } }); return { c: mul(add(lo, hi), 0.5), e: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: mul(sub(hi, lo), 0.5) }; }
  };
  return K;
}

/* ------------------------------------------------------------------ CSS (Kidney Burgundy brand tokens; machine tokens fixed in both themes) */
var CSS = [
':root{--paper:#E6D3D4;--surface:#F5EBED;--ink:#2A1417;--muted:#4A3639;--line:#CCB8BA;--teal:#8E2D3B;--teal-deep:#8E2D3B;--mist:#DBBDC0;--teal-fill:#ECDADC;--teal-line:#D6B2B8;--sun:#2E7476;--sun-text:#1F5557;--on-teal:#FFFFFF;--shadow:0 18px 45px rgba(42,20,23,.20),inset 0 1px 0 rgba(255,255,255,.7);--shadow-btn:0 9px 22px rgba(42,20,23,.18),inset 0 1px 0 rgba(255,255,255,.7);--grain:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%27180%27%3E%3Cfilter id=%27n%27 x=%270%27 y=%270%27 width=%27100%25%27 height=%27100%25%27 color-interpolation-filters=%27sRGB%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.85%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3CfeColorMatrix type=%27matrix%27 values=%270 0 0 0 0.165 0 0 0 0 0.078 0 0 0 0 0.09 1.8 0 0 0 -.6%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E\");--r-leaf:10px 3px 10px 3px;--ease:cubic-bezier(.65,0,.35,1);--dur:240ms;--glass:color-mix(in srgb,var(--surface) 55%,transparent);--glow:color-mix(in srgb,var(--teal) 16%,transparent);',
'--screen:#0D0C0D;--screen-2:#171517;--trace:#78D2C4;--trace-2:#E0A458;--grid:#2C2729;--scr-ink:#ECE5E4;--scr-muted:#A89B9C;--ctl-on:#E58A98;--ctl-on-ink:#2A0E14;',  /* scanner palette shared with index.html and vexus.html (2026-10-06) */
'--font-display:"Cormorant Garamond",Georgia,serif;--font-body:"Figtree",system-ui,sans-serif;--font-mono:"Red Hat Mono",ui-monospace,Menlo,monospace;color-scheme:light}',
'@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#1B1013;--surface:#261A1D;--ink:#F3E7E8;--muted:#D2BFC1;--line:#43302F;--teal:#E58A98;--teal-deep:#8E2D3B;--mist:#2E1A1E;--teal-fill:#3A1D24;--teal-line:#7A3A47;--sun:#6FB5B7;--sun-text:#8FCFD1;--on-teal:#1B1013;--shadow:0 18px 45px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.12);--shadow-btn:0 9px 22px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.12);--grain:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%27180%27%3E%3Cfilter id=%27n%27 x=%270%27 y=%270%27 width=%27100%25%27 height=%27100%25%27 color-interpolation-filters=%27sRGB%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.85%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3CfeColorMatrix type=%27matrix%27 values=%270 0 0 0 0.953 0 0 0 0 0.906 0 0 0 0 0.91 1.8 0 0 0 -.6%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E\");color-scheme:dark}}',
':root[data-theme="dark"]{--paper:#1B1013;--surface:#261A1D;--ink:#F3E7E8;--muted:#D2BFC1;--line:#43302F;--teal:#E58A98;--teal-deep:#8E2D3B;--mist:#2E1A1E;--teal-fill:#3A1D24;--teal-line:#7A3A47;--sun:#6FB5B7;--sun-text:#8FCFD1;--on-teal:#1B1013;--shadow:0 18px 45px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.12);--shadow-btn:0 9px 22px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.12);--grain:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%27180%27%3E%3Cfilter id=%27n%27 x=%270%27 y=%270%27 width=%27100%25%27 height=%27100%25%27 color-interpolation-filters=%27sRGB%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.85%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3CfeColorMatrix type=%27matrix%27 values=%270 0 0 0 0.953 0 0 0 0 0.906 0 0 0 0 0.91 1.8 0 0 0 -.6%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E\");color-scheme:dark}',
'*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}[hidden]{display:none!important}',
'html:root:root{background:var(--paper);color:var(--ink)}html:root:root body{background:transparent;color:var(--ink)}',
'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(40% 30% at 12% 8%,color-mix(in srgb,var(--teal) 26%,transparent),transparent),radial-gradient(38% 30% at 92% 55%,color-mix(in srgb,var(--sun) 24%,transparent),transparent)}',
'body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:var(--grain);background-size:180px 180px;opacity:.06}',
'body{margin:0;background:transparent;color:var(--ink);font-family:var(--font-body);font-size:16px;line-height:1.5;padding:calc(14px + env(safe-area-inset-top,0px)) calc(16px + env(safe-area-inset-right,0px)) calc(28px + env(safe-area-inset-bottom,0px)) calc(16px + env(safe-area-inset-left,0px))}',
'button,input,select{font:inherit;color:inherit}:focus-visible{outline:3px solid var(--sun);outline-offset:2px}',
'.pb{max-width:1320px;margin:0 auto;display:flex;flex-direction:column;gap:12px}',
'.pb-head{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap}',
'.pb-lock{display:flex;align-items:center;gap:10px;min-width:0}.pb-lock svg{flex:none}',
'.pb-eyebrow{font-size:12.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--sun-text);font-weight:700;line-height:1.2}',
'.pb-head h1{font-family:var(--font-display);font-weight:600;letter-spacing:-.01em;font-size:clamp(24px,4vw,32px);line-height:1.05;margin:0;text-wrap:balance}',
'.pb-back{color:var(--teal);font-weight:700;display:inline-flex;align-items:center;min-height:44px}',
'.pb-embed .pb-back,.pb-embed .pb-eyebrow,.pb-embed .pb-lock svg{display:none}.pb-embed .pb-head h1{font-size:21px}',
'.pb-seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--r-leaf);box-shadow:var(--shadow-btn);padding:3px;background:var(--surface);gap:2px}',
'.pb-seg button{border:0;background:none;min-height:44px;padding:6px 14px;border-radius:8px 2px 8px 2px;cursor:pointer;font-weight:600;color:var(--muted);transition:background-color var(--dur) var(--ease),color var(--dur) var(--ease)}',
'.pb-seg button[aria-pressed="true"]{background:linear-gradient(180deg,color-mix(in srgb,var(--teal) 80%,#fff),var(--teal));color:var(--on-teal)}',
'.pb-views{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 6px;scrollbar-width:thin}',
'.pb-chip{flex:none;min-height:44px;padding:6px 12px;border:1px solid var(--line);border-radius:var(--r-leaf);background:var(--surface);cursor:pointer;text-align:left;line-height:1.15;transition:background-color var(--dur) var(--ease),border-color var(--dur) var(--ease);display:flex;flex-direction:column;justify-content:center}',
'.pb-chip small{color:var(--muted);font-size:12px}.pb-chip b{font-weight:600;font-size:14.5px}',
'.pb-chip[aria-pressed="true"]{border-color:var(--teal);box-shadow:inset 0 0 0 1px var(--teal);background:var(--teal-fill)}',
'.pb-chip.done b::after{content:" \\2713";color:var(--teal)}',
'.pb-grid{display:grid;gap:12px;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);grid-template-areas:"img gl" "img notes" "ctl notes";grid-template-rows:auto auto 1fr;align-items:start}',
'.pb-img{grid-area:img}.pb-3d{grid-area:gl}.pb-ctl{grid-area:ctl}.pb-notes{grid-area:notes}',
'@media (max-width:860px){.pb-grid{grid-template-columns:minmax(0,1fr);grid-template-areas:"img" "gl" "ctl" "notes";grid-template-rows:none}}',
'@media (max-width:480px){.pb-seg{width:100%}.pb-seg button{padding:6px 8px;font-size:14.5px;flex:1 1 auto}.pb-back{min-height:44px;font-size:15px}}',
'.pb-pane{background:var(--screen);border:1px solid var(--grid);border-radius:var(--r-leaf);color:var(--scr-ink);min-width:0;overflow:hidden}',
'.pb-ph{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--grid);flex-wrap:wrap;font-size:13.5px}',
'.pb-ph h2{font-family:var(--font-body);font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0;color:var(--trace)}',
'.pb-ph span{font-family:var(--font-mono);font-size:12px;color:var(--scr-muted)}',
'.pb-cv{display:block;width:100%;height:auto;background:#000}.pb-strip{display:block;width:100%;height:auto;background:#000;border-top:1px solid var(--grid)}',
'.pb-tb{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-top:1px solid var(--grid)}',
'.pb-meas{padding:0 12px 8px;font-family:var(--font-mono);font-size:13px;color:var(--scr-ink);display:flex;flex-wrap:wrap;gap:4px 14px}.pb-meas b{color:var(--trace-2)}',
'.pb-coach{padding:10px 12px;border-top:1px solid var(--grid);display:flex;flex-direction:column;gap:6px}',
'.pb-bar{display:grid;grid-template-columns:86px minmax(0,1fr) 58px;gap:8px;align-items:center;font-size:13px}',
'.pb-bar .trk{height:10px;border-radius:5px;background:var(--screen-2);border:1px solid var(--grid);position:relative;overflow:hidden}',
'.pb-bar .trk i{position:absolute;left:0;top:0;bottom:0;background:var(--trace-2);border-radius:5px}.pb-bar.ok .trk i{background:var(--trace)}',
'.pb-bar .trk b{position:absolute;left:33.3%;top:0;bottom:0;width:2px;background:var(--scr-ink);opacity:.7}',
'.pb-bar .val{font-family:var(--font-mono);text-align:right;font-variant-numeric:tabular-nums}',
'.pb-req{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px}',
'.pb-req li::before{content:"\\25CB  ";color:var(--trace-2)}.pb-req li.ok::before{content:"\\25CF  ";color:var(--trace)}',
'.pb-hint{margin:0;font-size:15px;min-height:1.5em;color:var(--scr-ink)}.pb-hint b{color:var(--trace)}',
'.pb-hold{height:4px;background:var(--screen-2);border-radius:2px;overflow:hidden}.pb-hold i{display:block;height:100%;width:0;background:var(--trace)}',
'.pb-stage{position:relative;aspect-ratio:4/3;max-height:540px;width:100%}.pb-gl{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}',
'.pb-giz{position:absolute;left:8px;bottom:8px;width:84px;height:84px;pointer-events:none}',
'.pb-nogl{padding:18px 14px;color:var(--scr-muted);font-size:14.5px;margin:0}',
'.pb-card{background:var(--glass);-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5);border:1px solid var(--line);border-radius:var(--r-leaf);box-shadow:var(--shadow);padding:14px;min-width:0}',
'.pb-card h2{font-family:var(--font-display);font-size:21px;font-weight:600;letter-spacing:-.01em;line-height:1.15;margin:0 0 8px}.pb-card h3{font-family:var(--font-display);font-size:18.5px;font-weight:600;line-height:1.2;margin:14px 0 4px}',
'.pb-sl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 10px;align-items:center}',
'.pb-sl label{font-size:14.5px;font-weight:600}.pb-sl output{font-family:var(--font-mono);font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}',
'.pb-sl input[type=range]{grid-column:1/-1;width:100%;height:44px;margin:0;accent-color:var(--teal)}.pb-sl .pbc{grid-column:1/-1}',
'.pb-sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:2px 18px}',
'.pb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
'.pb-btn{min-height:44px;padding:6px 16px;border-radius:var(--r-leaf);border:1px solid var(--teal);background:linear-gradient(180deg,color-mix(in srgb,var(--teal) 80%,#fff),var(--teal));color:var(--on-teal);font-weight:600;cursor:pointer;box-shadow:var(--shadow-btn);transition:box-shadow var(--dur) var(--ease)}.pb-btn:hover:not(:disabled){box-shadow:0 0 0 4px var(--glow),var(--shadow-btn)}',
'.pb-btn.alt{background:var(--surface);color:var(--teal)}.pb-btn:disabled{opacity:.5;cursor:default}',
'.pb-sel{min-height:44px;padding:6px 10px;border-radius:var(--r-leaf);border:1px solid var(--line);background:var(--surface);color:var(--ink);max-width:100%}',
'.pb-field{display:flex;flex-direction:column;gap:2px;font-size:14.5px;font-weight:700;min-width:0}',
'.pb-pad{width:132px;height:132px;border-radius:var(--r-leaf);border:1px solid var(--line);background:var(--teal-fill);position:relative;touch-action:none;flex:none;cursor:crosshair}',
'.pb-pad i{position:absolute;width:26px;height:26px;border-radius:50%;background:var(--teal);left:50%;top:50%;margin:-13px 0 0 -13px;pointer-events:none}',
'.pb-pad::before,.pb-pad::after{content:"";position:absolute;background:var(--line)}.pb-pad::before{left:50%;top:6px;bottom:6px;width:1px}.pb-pad::after{top:50%;left:6px;right:6px;height:1px}',
'.pb-penchip{align-self:center;font-size:13px;font-weight:700;color:var(--scr-ink);opacity:.85;padding:0 4px}',
'.pb-pen{margin-top:10px;font-size:14px}.pb-pen summary{cursor:pointer;font-weight:700;min-height:32px}.pb-pen ul{margin:4px 0 0;padding-left:20px;color:var(--muted)}',
'.pb-padwrap{display:flex;gap:12px;align-items:center;margin-top:8px;flex-wrap:wrap}.pb-padwrap p{margin:0;font-size:14px;color:var(--muted);flex:1 1 150px;min-width:0}',
'.pb-notes p,.pb-notes li{max-width:68ch}.pb-notes ul{margin:4px 0;padding-left:20px;list-style:"\\2013  "}.pb-notes li::marker{color:var(--teal)}.pb-muted{color:var(--muted);font-size:14.5px}',
'.pb-notes details.pb-sec{border-top:1px solid var(--line);margin:0}.pb-notes details.pb-sec:last-of-type{border-bottom:1px solid var(--line)}',
'.pb-sec>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:44px;padding:2px 0}.pb-sec>summary::-webkit-details-marker{display:none}',
'.pb-sec>summary h3{margin:0;flex:1;min-width:0}.pb-sec>summary::after{content:"";flex:0 0 auto;width:8px;height:8px;margin:0 6px 4px 0;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg)}',
'.pb-sec[open]>summary::after{transform:rotate(-135deg);margin-bottom:-4px}.pb-sec>summary:hover h3{color:var(--teal)}.pb-sec[open]{padding-bottom:10px}',
'.pb-call details{border-top:1px solid var(--teal-line);margin-top:6px}.pb-call details>summary{cursor:pointer;min-height:40px;display:flex;align-items:center;font-weight:700;list-style:none}.pb-call details>summary::-webkit-details-marker{display:none}.pb-call details>summary::before{content:"\\25B8";margin-right:8px;color:var(--teal)}.pb-call details[open]>summary::before{content:"\\25BE"}',
'.pb-call{background:var(--teal-fill);border:1px solid var(--teal-line);border-radius:var(--r-leaf);padding:10px 12px;margin:10px 0}.pb-call p{margin:0}',
'.pb-tag{display:inline-block;font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;color:var(--sun-text)}',
'.pb-notes ul.pb-check{list-style:none;margin:8px 0;padding:0;display:flex;flex-direction:column;gap:6px}',
'.pb-check button{width:100%;min-height:44px;text-align:left;border:1px solid var(--line);border-radius:var(--r-leaf);background:var(--surface);padding:6px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center}',
'.pb-check button[aria-pressed="true"]{border-color:var(--teal);background:var(--teal-fill)}.pb-check .s{font-family:var(--font-mono);font-size:13px;color:var(--muted);text-align:right}',
'.pb-opts{display:grid;gap:6px;margin:8px 0}.pb-opts button{min-height:44px;text-align:left;border:1px solid var(--line);border-radius:var(--r-leaf);background:var(--surface);padding:8px 12px;cursor:pointer}',
'.pb-opts button.right{border-color:#2E7A4E;box-shadow:inset 0 0 0 2px #2E7A4E}.pb-opts button.wrong{border-color:#B42318;box-shadow:inset 0 0 0 2px #B42318}',
'.pb-foot{color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:10px}.pb-foot p{margin:2px 0;max-width:80ch}',
'.pb-prog{font-family:var(--font-mono);font-size:13px;color:var(--muted)}',
/* cart console (Sonosite PX / GE Venue style). Same class names and palette as pbconsole.css (in-page benches). bench-controls.js also uses
   .pbc for its fader wrapper, so the console root is matched as .pbc.pbc-console to win over that rule. Dark in both themes. */
'.pbc.pbc-console{ --pbc-strip:#0e1114; --pbc-panel:#1b1f24; --pbc-key:#2a3038; --pbc-key-h:#3a424d; --pbc-tx:#e6e9ee; --pbc-dim:#9aa4b1; --pbc-on:#36c2b4; --pbc-frz:#f0b429; --pbc-line:#323942; --pbc-ink:#0e1114; --pbc-lcd:#0b0d10; display:block; width:auto; min-width:0; gap:0; align-items:stretch; margin:0; border-radius:12px; overflow:hidden; background:var(--pbc-panel); border:1px solid var(--pbc-line); box-shadow:0 1px 0 rgba(255,255,255,.04) inset, 0 6px 18px rgba(0,0,0,.35); color:var(--pbc-tx); font:600 13px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
'.pbc.pbc-console:has(.pbc-r:focus-visible){outline:none}',
'.pbc.pbc-console *{box-sizing:border-box}',
'.pbc.pbc-console :focus-visible{outline:2px solid var(--pbc-on);outline-offset:2px}',
'.pbc.pbc-console .pbc-strip{ display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px; padding:7px 14px; background:var(--pbc-strip); border-bottom:1px solid var(--pbc-line); font:600 12px/1.3 ui-monospace,"SF Mono",Menlo,Consolas,monospace; letter-spacing:.04em; font-variant-numeric:tabular-nums; color:var(--pbc-dim); text-transform:uppercase;}',
'.pbc.pbc-console .pbc-probe{color:var(--pbc-tx)}',
'.pbc.pbc-console .pbc-preset{color:var(--pbc-dim)}',
'.pbc.pbc-console .pbc-d{margin-left:auto}',
'.pbc.pbc-console .pbc-d,.pbc.pbc-console .pbc-g{color:var(--pbc-tx)}',
'.pbc.pbc-console .pbc-mode{color:var(--pbc-on)}',
'.pbc.pbc-console .pbc-mode.frz{color:var(--pbc-frz)}',
'.pbc.pbc-console .pbc-strip [hidden]{display:none}',
'.pbc.pbc-console .pbc-preset+.pbc-mode, .pbc.pbc-console .pbc-preset+.pbc-d[hidden]+.pbc-g[hidden]+.pbc-mode{margin-left:auto}',
'.pbc.pbc-console .pbc-screen{padding:10px; background:#111418}',
'.pbc.pbc-console .pbc-screen:focus-visible{outline-offset:-3px}',
'.pbc.pbc-console .pbc-panel{ display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px 8px; padding:10px 12px 12px; background:var(--pbc-panel); border-top:1px solid var(--pbc-line);}',
'.pbc.pbc-console .pbc-cl{display:flex; flex-wrap:wrap; align-items:flex-end; gap:8px; min-width:0}',
'.pbc.pbc-console .pbc-cl+.pbc-cl{padding-left:8px; border-left:1px solid var(--pbc-line)}',
'.pbc.pbc-console .pbc-cl-more{margin-left:auto}',
'.pbc.pbc-console .pbc-cl-preset{flex:1 1 170px; min-width:160px; max-width:340px}',
'.pbc.pbc-console .pbc-key{ min-height:44px; min-width:44px; padding:0 14px; border-radius:8px; background:var(--pbc-key); color:var(--pbc-tx); border:1px solid #3d4550; box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 2px 3px rgba(0,0,0,.35); font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; letter-spacing:.05em; white-space:nowrap; cursor:pointer; touch-action:manipulation; -webkit-user-select:none; user-select:none; transition:background-color .12s,border-color .12s,color .12s;}',
'.pbc.pbc-console .pbc-key:hover{background:var(--pbc-key-h)}',
'.pbc.pbc-console .pbc-key:active{transform:translateY(1px); box-shadow:inset 0 2px 4px rgba(0,0,0,.4)}',
'.pbc.pbc-console .pbc-key.on{background:var(--pbc-on); border-color:#5fd6ca; color:var(--pbc-ink)}',
'.pbc.pbc-console .pbc-key.frz{background:var(--pbc-frz); border-color:#f6ca62; color:var(--pbc-ink)}',
'.pbc.pbc-console .frz-key{min-width:88px}',
'.pbc.pbc-console .pbc-auto{min-width:64px}',
'.pbc.pbc-console .pbc-more.open{border-color:var(--pbc-on); color:#bff0ea}',
'.pbc.pbc-console .pbc-modes{gap:0}',
'.pbc.pbc-console .pbc-modes .pbc-key{border-radius:0; margin-left:-1px; min-width:52px}',
'.pbc.pbc-console .pbc-modes .pbc-key:first-child{border-radius:8px 0 0 8px; margin-left:0}',
'.pbc.pbc-console .pbc-modes .pbc-key:last-child{border-radius:0 8px 8px 0}',
'.pbc.pbc-console .pbc-step,.pbc.pbc-console .pbc-sel{display:flex; flex-direction:column; gap:4px; min-width:0}',
'.pbc.pbc-console .pbc-step[hidden]{display:none}',
'.pbc.pbc-console .pbc-step small,.pbc.pbc-console .pbc-sel small{ font:600 10.5px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; letter-spacing:.09em; text-transform:uppercase; color:var(--pbc-dim); white-space:nowrap; padding-left:2px;}',
'.pbc.pbc-console .pbc-sbox{display:flex; align-items:stretch; border-radius:8px; border:1px solid #3d4550; overflow:hidden; background:var(--pbc-key)}',
'.pbc.pbc-console .pbc-sbox button{ width:44px; min-height:44px; border:0; background:transparent; color:var(--pbc-tx); font:600 20px/1 system-ui,sans-serif; cursor:pointer; touch-action:manipulation; -webkit-user-select:none; user-select:none;}',
'.pbc.pbc-console .pbc-sbox button:hover{background:var(--pbc-key-h)}',
'.pbc.pbc-console .pbc-sbox button.held{background:#4a5360}',
'.pbc.pbc-console .pbc-sbox button:disabled{opacity:.35; cursor:default; background:transparent}',
'.pbc.pbc-console .pbc-sbox output{ min-width:64px; padding:0 8px; display:flex; align-items:center; justify-content:center; background:var(--pbc-lcd); border-left:1px solid #3d4550; border-right:1px solid #3d4550; font:600 14px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; color:var(--pbc-tx); white-space:nowrap;}',
'.pbc.pbc-console .pbc-sel select{ -webkit-appearance:none; appearance:none; width:100%; min-height:44px; padding:0 34px 0 12px; border-radius:8px; border:1px solid #3d4550; color:var(--pbc-tx); cursor:pointer; background:var(--pbc-key) url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\' viewBox=\'0 0 12 8\'%3E%3Cpath d=\'M1 1l5 5 5-5\' fill=\'none\' stroke=\'%239aa4b1\' stroke-width=\'2\'/%3E%3C/svg%3E") no-repeat right 12px center; font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; text-overflow:ellipsis;}',
'.pbc.pbc-console .pbc-sel select:hover{background-color:var(--pbc-key-h)}',
'.pbc.pbc-console .pbc-sel select option{background:#1b1f24; color:#e6e9ee}',
'.pbc.pbc-console .pbc-moderow{ display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px 8px; padding:10px 12px 12px 10px; background:#171b20; border-top:1px dashed var(--pbc-line); box-shadow:inset 3px 0 0 var(--pbc-on);}',
'.pbc.pbc-console .pbc-moderow .pbc-sbox output{min-width:60px}',
'.pbc.pbc-console .pbc-drawer{display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:14px 14px; align-items:start; padding:12px; background:#15191d; border-top:1px solid var(--pbc-line)}',
'.pbc.pbc-console .pbc-grp.pbc-wide{grid-column:1/-1}',
'.pbc.pbc-console .pbc-drawer[hidden]{display:none}',
'.pbc.pbc-console .pbc-grp{display:flex; flex-direction:column; gap:8px; min-width:0}',
'.pbc.pbc-console .pbc-grp>h4{ margin:0; font:600 11px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; letter-spacing:.11em; text-transform:uppercase; color:var(--pbc-dim);}',
'@media (prefers-reduced-motion:reduce){.pbc.pbc-console .pbc-key{transition:none}}',
'.pb .pbc.pbc-console{border-radius:0;border:0;box-shadow:none}.pbc.pbc-console .pbc-screen{padding:0;background:#000;position:relative}',
'.pbc.pbc-console .pbc-strip .pbc-preset{overflow:hidden;text-overflow:ellipsis;max-width:100%}.pbc.pbc-console .pbc-hz{color:var(--pbc-dim)}',
'.pbc.pbc-console .pbc-cl-more{order:99}.pbc.pbc-console .pbc-panel>button{align-self:flex-end}.pbc.pbc-console .pbc-sel .pbc-psel{max-width:100%}',
'.pbc-hint{margin:0;padding:5px 12px;background:#0e1114;color:#9aa4b1;font:500 12px/1.3 system-ui,sans-serif;border-top:1px solid #323942}',
/* page-added keys (Sniff, Valsalva, Hold, ECG, M) and the 3D-pane toolbar share the key look */
'.pb-tb{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;padding:10px 12px 12px;background:#1b1f24;border-top:1px solid #323942}',
'.pb-tb>button,.pbc-keys>button{min-height:44px;min-width:44px;padding:0 14px;border-radius:8px;background:#2a3038;color:#e6e9ee;border:1px solid #3d4550;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 2px 3px rgba(0,0,0,.35);font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.05em;white-space:nowrap;cursor:pointer;touch-action:manipulation;-webkit-user-select:none;user-select:none;transition:background-color .12s}',
'.pb-tb>button:hover:not(:disabled),.pbc-keys>button:hover{background:#3a424d}.pb-tb>button[aria-pressed="true"],.pbc-keys>button[aria-pressed="true"],.pbc.pbc-console .pbc-key[aria-pressed="true"]{background:#36c2b4;border-color:#5fd6ca;color:#0e1114}',
'.pbc.pbc-console .pbc-key.frz{background:#f0b429!important;border-color:#f6ca62!important;color:#0e1114!important}.pb-tb>button:disabled{opacity:.42;cursor:default}',
'.pbc.pbc-console .pbc-grp .pb-sliders{grid-template-columns:minmax(0,1fr);gap:0}.pbc-grp .pb-sl label{font:600 13px system-ui,sans-serif;color:#e6e9ee}.pbc-grp .pb-sl output{color:#9aa4b1}',
'.pbc-grp .pb-field{color:#e6e9ee;font:600 13px system-ui,sans-serif;margin-top:6px}.pbc-grp .pb-sel{background:#2a3038;color:#e6e9ee;border:1px solid #3d4550;border-radius:8px}',
'.pbc-keys{display:flex;flex-wrap:wrap;gap:8px}.pbc-grp p{margin:6px 0 0;font:500 12.5px/1.4 system-ui,sans-serif;color:#9aa4b1}',
'.pb-3d .pb-tb{border-top:1px solid #000}.pb-3d .pb-ph,.pb-img>.pb-meas,.pb-img>.pb-coach{background:var(--screen)}',
/* anatomy credits panel (3D pane) and loading note */
'.pb-stage .pb-load{position:absolute;inset:auto 0 0 0;margin:0;padding:8px 12px;font:500 12.5px system-ui,sans-serif;color:#9aa4b1;pointer-events:none}',
'.pb-credits{position:absolute;right:8px;top:8px;bottom:8px;width:min(360px,calc(100% - 16px));overflow:auto;background:rgba(14,17,20,.94);border:1px solid #3a424d;border-radius:10px;padding:10px 12px;color:#e6e9ee;font:500 12.5px/1.45 system-ui,sans-serif;z-index:3}',
'.pb-credits h3{margin:0 0 6px;font:700 12px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#36c2b4}.pb-credits ul{margin:0;padding-left:16px}.pb-credits li{margin:0 0 6px}.pb-credits a{color:#7fd8cf}.pb-credits p{margin:6px 0 0;color:#9aa4b1}',
'.pb-credits button{float:right;min-height:32px;min-width:32px;border-radius:8px;border:1px solid #0b0e11;background:#2a3038;color:#e6e9ee;cursor:pointer;font:700 14px system-ui}',
'.pb-foot .pb-mcred{font-size:13px}',
'@keyframes pbSlide{from{opacity:0;transform:translateX(-22px)}to{opacity:1;transform:none}}',
'.pb-head,.pb-views,.pb-card{animation:pbSlide var(--dur) var(--ease) backwards}.pb-views{animation-delay:60ms}.pb-card{animation-delay:120ms}',
'@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}'
].join('\n');
var MARK = '<svg width="30" height="30" viewBox="0 0 100 100" aria-hidden="true"><path d="M60 8C82 8 94 28 93 50C92 74 76 92 56 92C41 92 33 82 37 71C40 63 49 60 49 50C49 40 40 37 37 29C33 18 44 8 60 8Z" fill="var(--teal)"/><path d="M4 70C16 70 22 50 34 50H49" fill="none" stroke="var(--sun)" stroke-width="7" stroke-linecap="round"/></svg>';
var DISCLAIMER = 'Educational simulation with modelled anatomy. Not a diagnostic device.';
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function el(tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); } if (html != null) e.innerHTML = html; return e; }

/* ================================================================== create */
function create(cfg) {
  var mount = typeof cfg.mount === 'string' ? document.querySelector(cfg.mount) : (cfg.mount || document.body);
  if (!document.getElementById('pb-css')) { var sty = el('style', { id: 'pb-css' }); sty.textContent = CSS; document.head.appendChild(sty); }
  if (!document.querySelector('link[href*="Cormorant+Garamond"]')) { var fl = el('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Figtree:wght@400;500;600;700&family=Red+Hat+Mono:wght@400;500;600&display=swap' }); document.head.appendChild(fl); }   // brand fonts, for a host page that still links the old ones
  var qs; try { qs = new URLSearchParams(location.search); } catch (e) { qs = { get: function () { return null; } }; }
  var EMBED = !!qs.get('embed') || location.hash === '#embed';
  var REDUCED = false; try { REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var TIS = cfg.tissues, NT = TIS.length, VIEWS = cfg.views, VARS = cfg.variants || [{ id: 'normal', name: 'Normal', answer: 'Normal' }];
  var PROBES = cfg.probes, MS = cfg.markerSide === 'right' ? 1 : -1;
  var viewBy = {}, varBy = {}; VIEWS.forEach(function (v) { viewBy[v.id] = v; }); VARS.forEach(function (v) { varBy[v.id] = v; });
  var AX = cfg.axisWords || { x: ['the patient’s left', 'the patient’s right'], y: ['the head', 'the feet'], z: ['the front (anterior)', 'the back (posterior)'] };

  /* tissue tables */
  var tEcho = new Float32Array(NT), tSpk = new Float32Array(NT), tMot = new Float32Array(NT), tAtt = new Float32Array(NT), tSpec = new Float32Array(NT), tRefl = new Float32Array(NT), tDirty = new Float32Array(NT);
  var tRev = new Uint8Array(NT), tMir = new Uint8Array(NT), tTw = new Uint8Array(NT), tFlow = new Uint8Array(NT);
  /* measured grey palette (2026-10-18, 47 clips): streaked fat / muscle texture, near-field haze in large fluid collections, clutter floor in clean shadows.
     Optional tissue keys (defaults derived below): streak (0..1.5, strength), streakType ('fat' | 'muscle'), haze (0..1), shadowFloor (true/false, for reflectors). */
  var tStr = new Float32Array(NT), tStrT = new Uint8Array(NT), tHaze = new Float32Array(NT), tShF = new Uint8Array(NT);
  TIS.forEach(function (t, i) {
    tEcho[i] = t.echo || 0; tSpk[i] = t.speck == null ? 1 : t.speck; tMot[i] = t.mot == null ? 0.5 : t.mot; tAtt[i] = t.atten == null ? 1 : t.atten; tSpec[i] = t.spec == null ? 0.12 : t.spec;
    tRefl[i] = t.reflect || 0; tDirty[i] = t.dirty || 0; tRev[i] = t.reverb ? 1 : 0; tMir[i] = t.mirror ? 1 : 0; tTw[i] = t.twinkle ? 1 : 0; tFlow[i] = t.flow ? 1 : 0;
    var key = String(t.key || ''), isFat = /^(FAT|SCFAT)$/.test(key), isMus = /^(MUSC|MUSCLE)$/.test(key);
    tStr[i] = t.streak != null ? t.streak : (isFat || isMus ? 1 : 0);                            // grain elongated parallel to the skin: fat ~8:1 with bright septa, muscle ~5:1 striations
    tStrT[i] = (t.streakType || (isFat ? 'fat' : 'muscle')) === 'fat' ? 1 : 2;
    tHaze[i] = t.haze != null ? t.haze : (tEcho[i] > 0 && tEcho[i] <= 0.012 && tSpk[i] === 0 && tAtt[i] <= 0.1 ? 1 : 0);   // large low-attenuation fluid (bladder, cyst, effusion, ascites)
    tShF[i] = t.shadowFloor != null ? (t.shadowFloor ? 1 : 0) : (tRefl[i] > 0 && !tRev[i] && !tMir[i] ? 1 : 0);             // bone, stone, calcium, gas: shadow keeps a clutter floor
  });

  /* ---------------- state */
  var S = null;                         // sim (anatomy) state: cfg.defaults() then variant.apply(S)
  var st = {
    mode: 'explore', view: VIEWS[0].id, variant: VARS[0].id, probe: null,
    O: [0, 0, 0], O0: null, rot: 0, tilt: 0, rock: 0, depth: 16, gain: 1, tgc: 0, sector: 100,
    frozen: false, playing: !REDUCED, t: 0, labels: true, fan: true, cut: false, drag: 'orbit',
    colour: false, pw: false, box: { c: 0.5, r: 0.45, w: 0.36, h: 0.34 }, gate: { c: 0.5, r: 0.45 }, scale: 30,
    cal: [], meas: [], reveal: true, seed: 1,
    find: { target: null, t0: 0, hold: 0, done: false, shown: false }, spot: null,
    pen: { on: false, p: 0, sent: 0, seen: false }   // Apple Pencil (or any stylus): contact, smoothed pressure 0..1
  };
  var pose = null, target = null, metrics = null;
  var dirty2 = true, dirty3 = true, poseDirty = true;
  var params = {};                      // user-set sim params (persist across variant changes)
  var listeners = {};
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function emit(ev, d) { (listeners[ev] || []).forEach(function (f) { try { f(d); } catch (e) {} }); }

  /* ---------------- progress: localStorage pb.sim.<name> + postMessage to the Bench */
  var PKEY = 'pb.sim.' + cfg.name, prog = { v: 1, views: {}, cases: {}, done: null };
  try { var raw = localStorage.getItem(PKEY); if (raw) { var pj = JSON.parse(raw); if (pj && pj.v === 1) prog = pj; } } catch (e) {}
  function saveProg() { try { localStorage.setItem(PKEY, JSON.stringify(prog)); } catch (e) {} }
  function announce(event, id, score) {
    var ts = Date.now(), msg = { source: 'pb-sim', sim: cfg.name, session: cfg.session || null, event: event, id: id, score: score, ts: ts, detail: { id: id, score: score, ts: ts } };
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, (location.origin && location.origin !== 'null') ? location.origin : '*'); } catch (e) {}
    emit(event, msg);
  }
  function findViews() { return VIEWS.filter(function (v) { return v.find !== false; }); }
  function checkComplete() {
    if (prog.done) return;
    var all = findViews().every(function (v) { return prog.views[v.id]; }), ok = 0, k;
    for (k in prog.cases) if (prog.cases[k].ok) ok++;
    if (all && ok >= (cfg.casesToComplete == null ? 5 : cfg.casesToComplete)) { prog.done = Date.now(); saveProg(); announce('complete', cfg.name, 100); }
  }

  /* ---------------- sim state / variants */
  function rebuildS() {
    S = cfg.defaults ? cfg.defaults() : {};
    for (var k in params) S[k] = params[k];           // user params first, so variant.apply can read them (e.g. S.drained)
    var v = varBy[st.variant]; if (v && v.apply) v.apply(S, rng(st.seed));
    if (cfg.onState) cfg.onState(S, api);
    if (scene3 && scene3.update) scene3.update(S, st.reveal);
    anatUpdate();
    poseDirty = dirty2 = dirty3 = true;
  }

  /* ---------------- pose model */
  function basisAt(O) {
    var s = cfg.skin.project(O), ref = s.ref || cfg.skin.ref || [0, 1, 0], u0 = sub(ref, mul(s.n, dot(ref, s.n)));
    if (len(u0) < 1e-3) u0 = sub([1, 0, 0], mul(s.n, s.n[0]));
    u0 = nrm(u0); return { O: s.p, n0: s.n, u0: u0, N0: cross(s.n, u0) };
  }
  function poseFrom(O, r, ti, rk) {
    var b = basisAt(O), u = rot(b.u0, b.n0, r * D2R), n = rot(b.n0, u, ti * D2R), N = nrm(cross(n, u));
    n = rot(n, N, rk * D2R); u = rot(u, N, rk * D2R);
    return { O: b.O, n: nrm(n), u: nrm(u), N: N };
  }
  function paramsFrom(O, n, u) {            // inverse of poseFrom
    var b = basisAt(O); n = nrm(n); u = nrm(sub(u, mul(n, dot(u, n)))); var N = nrm(cross(n, u));
    var u1 = cross(N, b.n0); if (len(u1) < 1e-4) u1 = b.u0; u1 = nrm(u1);
    var n1 = cross(u1, N); if (dot(n1, b.n0) < 0) { u1 = mul(u1, -1); n1 = mul(n1, -1); }
    return {
      O: b.O, rot: Math.atan2(dot(u1, cross(b.n0, b.u0)), dot(u1, b.u0)) * R2D,
      tilt: Math.atan2(dot(n1, cross(u1, b.n0)), dot(n1, b.n0)) * R2D, rock: Math.atan2(dot(n, cross(N, n1)), dot(n, n1)) * R2D
    };
  }
  function resolveTarget(view) {
    var p = typeof view.pose === 'function' ? view.pose(S, api) : view.pose, q;
    if (p.n) { q = paramsFrom(p.O, p.n, p.u); } else { q = { O: basisAt(p.O).O, rot: p.rot || 0, tilt: p.tilt || 0, rock: p.rock || 0 }; }
    var P = poseFrom(q.O, q.rot, q.tilt, q.rock); P.rot = q.rot; P.tilt = q.tilt; P.rock = q.rock; return P;
  }
  function computePose() { pose = poseFrom(st.O, st.rot, st.tilt, st.rock); st.O = pose.O; poseDirty = false; target = resolveTarget(viewBy[st.view]); }

  /* ---------------- probe geometry */
  function probe() { return PROBES[st.probe]; }
  function geom() {
    var p = probe(), type = p.type, R = type === 'curvilinear' ? (p.radius || 60) : 0;
    var half = type === 'linear' ? 0 : (p.fov || 70) / 2 * D2R * st.sector / 100;
    return { type: type, R: R, half: half, W: p.width || 40, D: st.depth * 10 };
  }

  /* ---------------- B-mode buffers */
  var bm, bx, EW = 512, EH = 448, TOP = 22, img, QUAL = [[128, 224], [176, 304], [224, 384]], qi = 1, NL, NS;
  if (cfg.maxQuality != null) QUAL = QUAL.slice(0, cfg.maxQuality + 1); qi = Math.min(qi, QUAL.length - 1);
  var pol, ids, cv, spk, mot, stF, stM, LOx, LDx, lutIdx = new Int32Array(EW * EH), lutL = new Float32Array(EW * EH), lutS = new Float32Array(EW * EH), lutN = 0, lutKey = '', G = null, ppv = 1, hist = new Uint32Array(NT), histN = 1;
  var fv = new Float32Array(3), seedTw = 99;
  function rnd() { seedTw = (seedTw * 1664525 + 1013904223) >>> 0; return seedTw / 4294967296; }
  function allocQ() {
    NL = QUAL[qi][0]; NS = QUAL[qi][1];
    pol = new Float32Array(NL * NS); ids = new Uint8Array(NL * NS); cv = new Float32Array(NL * NS); spk = new Float32Array(NL * NS); mot = new Float32Array(NL * NS);
    LOx = new Float32Array(NL * 3); LDx = new Float32Array(NL * 3);
    var seed = 1234567, r = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; }, n = NL * NS, i, l, s;
    var rw = new Float32Array(n); for (i = 0; i < n; i++) rw[i] = Math.sqrt(-2 * Math.log(r()));
    // speckle grain: lateral kernel [1,2,3,2,1] over +-2 lines x axial [1,2,1] (measured liver grain is ~1.7x wider laterally than axially; the old 3x3 kernel was isotropic).
    // Exponent 1.8 restores the displayed fine contrast of the old field (0.128 vs 0.126 for speck 1); lateral half-width 1.34 -> 2.08 lines, axial unchanged at 1.36 samples.
    var KL = [1, 2, 3, 2, 1], KS = [1, 2, 1];
    for (l = 0; l < NL; l++) for (s = 0; s < NS; s++) { var acc = 0, w = 0; for (var dl = -2; dl <= 2; dl++) for (var ds = -1; ds <= 1; ds++) { var L = l + dl, Sx = s + ds; if (L < 0 || L >= NL || Sx < 0 || Sx >= NS) continue; var ww = KL[dl + 2] * KS[ds + 1]; acc += rw[L * NS + Sx] * ww; w += ww; } spk[l * NS + s] = acc / w; }
    var m = 0; for (i = 0; i < n; i++) m += spk[i]; m /= n; for (i = 0; i < n; i++) spk[i] = Math.pow(spk[i] / m, 1.8);
    // coarse mottle: separable box blur of white noise, two passes
    var a = new Float32Array(n), b = new Float32Array(n); for (i = 0; i < n; i++) a[i] = r();
    var blur = function (src, dst, rl, rs) { var l2, s2, k, acc2, c; for (l2 = 0; l2 < NL; l2++) for (s2 = 0; s2 < NS; s2++) { acc2 = 0; c = 0; for (k = -rs; k <= rs; k++) { var q = s2 + k; if (q >= 0 && q < NS) { acc2 += src[l2 * NS + q]; c++; } } dst[l2 * NS + s2] = acc2 / c; } for (s2 = 0; s2 < NS; s2++) for (l2 = 0; l2 < NL; l2++) { acc2 = 0; c = 0; for (k = -rl; k <= rl; k++) { var q2 = l2 + k; if (q2 >= 0 && q2 < NL) { acc2 += dst[q2 * NS + s2]; c++; } } src[l2 * NS + s2] = acc2 / c; } };
    blur(a, b, 3, 5); blur(a, b, 3, 5);
    var mn = 1, mx = 0; for (i = 0; i < n; i++) { if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
    for (i = 0; i < n; i++) mot[i] = 0.55 + 0.9 * (a[i] - mn) / (mx - mn);
    // streak fields (drawn after mot so the mot field is unchanged): thin bright lines long along the scan lines' lateral direction (parallel to the skin),
    // on a coarse lobular background. Fat: dark lobules + bright septa (aspect ~8:1); muscle: denser striations (~5:1). Both normalised to mean 1.
    var streak = function (rl, thr, k, lrl, lrs, lk) {
      var f = new Float32Array(n), c = new Float32Array(n), d = new Float32Array(n), j2, mu = 0, sd = 0, mu2 = 0, sd2 = 0, mm = 0;
      for (j2 = 0; j2 < n; j2++) c[j2] = r(); blur(c, d, rl, 0); blur(c, d, rl, 0);
      for (j2 = 0; j2 < n; j2++) { mu += c[j2]; sd += c[j2] * c[j2]; } mu /= n; sd = Math.sqrt(Math.max(1e-12, sd / n - mu * mu));
      var b2 = new Float32Array(n); for (j2 = 0; j2 < n; j2++) b2[j2] = r(); blur(b2, d, lrl, lrs); blur(b2, d, lrl, lrs);
      for (j2 = 0; j2 < n; j2++) { mu2 += b2[j2]; sd2 += b2[j2] * b2[j2]; } mu2 /= n; sd2 = Math.sqrt(Math.max(1e-12, sd2 / n - mu2 * mu2));
      for (j2 = 0; j2 < n; j2++) { var z = (c[j2] - mu) / sd - thr, lob = 1 + lk * 0.25 * (b2[j2] - mu2) / sd2; f[j2] = (lob < 0.3 ? 0.3 : lob) + (z > 0 ? k * Math.pow(z, 1.3) : 0); mm += f[j2]; }
      mm /= n; for (j2 = 0; j2 < n; j2++) f[j2] /= mm; return f;
    };
    stF = streak(4, 1.0, 1.7, 6, 3, 1.0); stM = streak(3, 0.9, 1.3, 8, 2, 0.6);   // lateral box radius 4 / 3 lines, no axial blur: grain aspect ~8:1 (fat) and ~5:1 (muscle) on the linear probe
    lutKey = '';
  }
  function buildLUT() {
    G = geom(); var key = [st.probe, st.depth, st.sector, qi].join('|'); if (key === lutKey) return; lutKey = key;
    var R = G.R, D = G.D, half = G.half, lin = G.type === 'linear', amax = lin ? G.W / 2 : (R + D) * Math.sin(half), cx = EW / 2, n = 0, x, y;
    ppv = Math.min((EH - TOP - 10) / D, (EW / 2 - 30) / amax);
    for (y = 0; y < EH; y++) for (x = 0; x < EW; x++) {
      var a = (x + 0.5 - cx) / ppv * MS, b = (y + 0.5 - TOP) / ppv, li, sj;
      if (lin) { if (Math.abs(a) >= G.W / 2 || b < 0 || b >= D) continue; li = (a / G.W + 0.5) * (NL - 1); sj = b / D * (NS - 1); }
      else { var bb = b + R, rr = Math.hypot(a, bb), th = Math.atan2(a, bb), rd = rr - R; if (bb <= 0 || rd < 0 || rd >= D || Math.abs(th) >= half) continue; li = (th + half) / (2 * half) * (NL - 1); sj = rd / D * (NS - 1); }
      lutIdx[n] = y * EW + x; lutL[n] = li; lutS[n] = sj; n++;
    }
    lutN = n;
  }
  /* plane coords (a along u, b along n, mm from O) <-> image px; and polar fractions */
  function plane2img(a, b) { return [EW / 2 + MS * a * ppv, TOP + b * ppv]; }
  function img2plane(px, py) { return [(px - EW / 2) / ppv * MS, (py - TOP) / ppv]; }
  function plane2polar(a, b) {            // -> {c: lateral 0..1, r: depth 0..1, ok}
    if (G.type === 'linear') return { c: a / G.W + 0.5, r: b / G.D, ok: Math.abs(a) < G.W / 2 && b >= 0 && b < G.D };
    var bb = b + G.R, rr = Math.hypot(a, bb), th = Math.atan2(a, bb), rd = rr - G.R; return { c: (th + G.half) / (2 * G.half), r: rd / G.D, ok: bb > 0 && rd >= 0 && rd < G.D && Math.abs(th) < G.half };
  }
  function polar2plane(c, r) {
    if (G.type === 'linear') return [(c - 0.5) * G.W, r * G.D];
    var th = -G.half + 2 * G.half * c, rr = G.R + r * G.D; return [rr * Math.sin(th), rr * Math.cos(th) - G.R];
  }
  function world2img(p) {
    var d = sub(p, pose.O), a = dot(d, pose.u), b = dot(d, pose.n), q = plane2polar(a, b), xy = plane2img(a, b);
    return { e: dot(d, pose.N), ok: q.ok, c: q.c, r: q.r, px: xy[0], py: xy[1] };
  }
  function lineGeo() {
    var O = pose.O, n = pose.n, u = pose.u, l, f, c, s, k, lin = G.type === 'linear';
    for (l = 0; l < NL; l++) {
      f = l / (NL - 1); k = l * 3;
      if (lin) { var w = (f - 0.5) * G.W; LOx[k] = O[0] + u[0] * w; LOx[k + 1] = O[1] + u[1] * w; LOx[k + 2] = O[2] + u[2] * w; LDx[k] = n[0]; LDx[k + 1] = n[1]; LDx[k + 2] = n[2]; }
      else {
        var th = -G.half + 2 * G.half * f; c = Math.cos(th); s = Math.sin(th);
        var dx = n[0] * c + u[0] * s, dy = n[1] * c + u[1] * s, dz = n[2] * c + u[2] * s;
        LDx[k] = dx; LDx[k + 1] = dy; LDx[k + 2] = dz; LOx[k] = O[0] + (dx - n[0]) * G.R; LOx[k + 1] = O[1] + (dy - n[1]) * G.R; LOx[k + 2] = O[2] + (dz - n[2]) * G.R;
      }
    }
  }
  function angleFactor(l, j, a, b, dr, lat) {
    var base = (l > 0 ? l - 1 : l + 1) * NS, d, jj;
    for (d = 0; d < 8; d++) {
      jj = j + d; if (jj > 0 && jj < NS && ids[base + jj - 1] === a && ids[base + jj] === b) break;
      jj = j - d; if (jj > 0 && jj < NS && ids[base + jj - 1] === a && ids[base + jj] === b) break;
    }
    if (d === 8) return 0.3;
    var sl = d * dr / lat; return 0.3 + 0.7 / (1 + sl * sl);
  }
  var KATT = 0.30, FMAX = 1.9;
  function renderB() {
    buildLUT(); lineGeo();
    var D = G.D, dr = D / (NS - 1), drcm = dr / 10, t = st.t, gap = cfg.contactGap || 16, tissueAt = cfg.tissueAt, lin = G.type === 'linear';
    var l, j, k, k0, id, x, y, z;
    if (cfg.frame) cfg.frame(S, t, api);
    hist.fill(0); var hl0 = Math.floor(NL * 0.2), hl1 = Math.ceil(NL * 0.8); histN = (hl1 - hl0) * NS;
    /* pass 1: tissue ids */
    for (l = 0; l < NL; l++) {
      k = l * 3; var ox = LOx[k], oy = LOx[k + 1], oz = LOx[k + 2], dx = LDx[k] * dr, dy = LDx[k + 1] * dr, dz = LDx[k + 2] * dr; k0 = l * NS;
      var inH = l >= hl0 && l < hl1;
      for (j = 0; j < NS; j++) { id = tissueAt(ox + dx * j, oy + dy * j, oz + dz * j, t, S); ids[k0 + j] = id; if (inH) hist[id]++; }
    }
    /* pass 2: brightness along each scanline */
    var gain = st.gain, tgc = st.tgc, dth = lin ? 0 : 2 * G.half / (NL - 1);
    /* stylus contact: light pressure couples poorly (dimmer image, near-field ring-down); firm pressure gives the full window */
    var cpl = cfg.penCoupling && st.pen.on ? 0.5 + 0.5 * Math.min(1, st.pen.p / 0.35) : 1;
    for (l = 0; l < NL; l++) {
      k0 = l * NS; var F = 1, F2 = 1, shD = 0, revG = 1, mirG = 1, prev = -1, entered = false, rev = -1, mir = -1, dAt = -1, dAmp = 0, ifc = 0, dead = false, hzAt = -1, hzAmp = 0;
      for (j = 0; j < NS; j++) {
        k = k0 + j; id = ids[k];
        if (!entered) { if (id === 0) { pol[k] = 0; if (j * dr > gap) { dead = true; break; } continue; } entered = true; }
        if (id !== prev && prev >= 0) {
          var sp = tSpec[id] > tSpec[prev] ? tSpec[id] : tSpec[prev];   // the brighter structure's own spec: capsule, diaphragm, pericardium and vessel walls reach display white (was min(), which let liver's 0.22 cap them)
          if (sp > 0) ifc = sp * angleFactor(l, j, prev, id, dr, lin ? G.W / (NL - 1) : (G.R + j * dr) * dth) * F;
          var Rf = tRefl[id];
          if (Rf > 0) { var rs = tSpec[id] * F; if (rs > ifc) ifc = rs;          // a reflector always shows a bright leading edge
            if (tRev[id] && rev < 0) { rev = j; revG = F / F2; } if (tMir[id] && mir < 0) { mir = j; mirG = F / F2; } if (tDirty[id] > 0 && dAt < 0) { dAt = j; dAmp = tDirty[id] * F; } F *= (1 - Rf); if (!tShF[id]) F2 *= (1 - Rf); else if (tDirty[id] > 0) shD = 1; }
          // revG / mirG (above): A-lines and the mirror image scale with the clean-shadow fraction, so none appear inside a rib shadow
          if (tHaze[id] > 0 && !tHaze[prev]) {                                // near-field haze under the anterior wall of a LARGE fluid space (>= 15 mm along the line)
            var jr = j; while (jr < NS && ids[k0 + jr] === id) jr++;
            if ((jr - j) * dr >= 15) { hzAt = j; var dz = j * dr - 20; hzAmp = 0.032 * tHaze[id] * (dz > 0 ? Math.exp(-dz / 50) : 1); } else hzAt = -1;
          } else if (!tHaze[id]) hzAt = -1;
        }
        var e = tEcho[id]; if (e > 0) { var sf = 1 + tSpk[id] * (spk[k] - 1); e *= (1 + tMot[id] * (mot[k] - 1)) * (sf < 0.06 ? 0.06 : sf); if (tStr[id] > 0) e *= 1 + tStr[id] * ((tStrT[id] === 1 ? stF[k] : stM[k]) - 1); }
        var v = e * F;
        if (F2 > F * 1.05 && id > 0) {                                        // clean shadow: a featureless clutter floor ~0.15 of mid-grey tissue (measured 0.12-0.24 behind rib / stone), speckled; gas shadows dirtier
          // the floor uses a fixed reference echo (liver 0.21) with the speckle field, NOT the hidden tissue's own echo, so no anatomy shows through a shadow (verification 2026-10-18)
          var eR = 0.21 * (1 + 0.9 * (spk[k] - 1)); if (eR < 0.02) eR = 0.02;
          var gf = (shD ? 0.2 : 0.15) * Math.sqrt(eR * F2), vf = gf * gf * (1 - F / F2);
          if (shD) vf *= spk[k];
          if (vf > v) v = vf;
        }
        if (hzAt >= 0) v += hzAmp * spk[k] * mot[k] * Math.exp(-(j - hzAt) * dr / 5);
        v += ifc; ifc *= 0.4; if (ifc < 0.01) ifc = 0;
        if (dAt >= 0) v += dAmp * 0.45 * spk[k] * Math.exp(-(j - dAt) * dr / 28);
        var fa = Math.exp(-KATT * (tAtt[id] - 1) * drcm); F *= fa; if (F > FMAX) F = FMAX; if (!(tShF[id] && tRefl[id] > 0)) { F2 *= fa; if (F2 > FMAX) F2 = FMAX; }
        pol[k] = v; prev = id;
      }
      if (dead) { for (; j < NS; j++) { pol[k0 + j] = 0; ids[k0 + j] = 0; } for (j = 0; j < NS; j += 1) pol[k0 + j] += 0.10 * spk[k0 + j] * Math.exp(-j * dr / 9) * (1 + Math.cos(j * dr * 1.1)); }
      if (rev > 2) { for (var n = 2; n <= 5; n++) { var jj = rev * n; if (jj >= NS - 2) break; var am = 0.5 / (n * 0.9) * revG; pol[k0 + jj] += am; pol[k0 + jj + 1] += am * 0.6; } }
      if (mir > 2) { for (j = mir + 2; j < NS; j++) { var js = 2 * mir - j; if (js < 0) break; var mv = pol[k0 + js] * 0.5 * mirG; if (mv > pol[k0 + j]) pol[k0 + j] = mv; } }
      for (j = 0; j < NS; j++) { var q = j / NS; k = k0 + j; var vv = pol[k] * gain * cpl * (1.05 - 0.3 * q + tgc * (q - 0.35)); if (j * dr < 5) vv += 0.22 * spk[k] * (1 - j * dr / 5); if (cpl < 1 && j * dr < 24) vv += (1 - cpl) * 0.9 * spk[k] * Math.exp(-j * dr / 10) * (0.55 + 0.45 * Math.cos(j * dr * 0.85)); pol[k] = vv; }
    }
    if (cfg.postPolar) cfg.postPolar({ pol: pol, ids: ids, NL: NL, NS: NS, dr: dr, G: G, S: S, t: t, st: st, spk: spk });
    /* colour Doppler box */
    var colour = st.colour && cfg.flowAt;
    if (colour) {
      cv.fill(0); var bxr = boxRange(), ny = st.scale, wf = ny * 0.06, flowAt = cfg.flowAt;
      for (l = bxr.l0; l <= bxr.l1; l++) {
        k = l * 3; var ex = LDx[k], ey = LDx[k + 1], ez = LDx[k + 2], px0 = LOx[k], py0 = LOx[k + 1], pz0 = LOx[k + 2], tw = 0; k0 = l * NS;
        for (j = bxr.j0; j <= bxr.j1; j++) {
          id = ids[k0 + j];
          if (tTw[id]) tw = Math.round(14 / dr);
          if (tw > 0) { tw--; if (rnd() < 0.62) cv[k0 + j] = rnd() * 2 - 1 || 0.01; continue; }
          if (!tFlow[id]) continue;
          x = px0 + ex * dr * j; y = py0 + ey * dr * j; z = pz0 + ez * dr * j;
          if (flowAt(x, y, z, t, S, id, fv)) { var vb = -(fv[0] * ex + fv[1] * ey + fv[2] * ez); if (Math.abs(vb) > wf) { var av = vb / ny; av = ((av + 1) % 2 + 2) % 2 - 1; cv[k0 + j] = av || 0.001; } }
        }
      }
    }
    /* scan conversion */
    var data = img.data, p, i; data.fill(0); for (i = 3; i < data.length; i += 4) data[i] = 255;
    for (p = 0; p < lutN; p++) {
      var Lf = lutL[p], Sf = lutS[p], l0 = Lf | 0, s0 = Sf | 0, fl = Lf - l0, fs = Sf - s0, l1 = l0 + 1 < NL ? l0 + 1 : l0, s1 = s0 + 1 < NS ? s0 + 1 : s0;
      var a = pol[l0 * NS + s0], b = pol[l0 * NS + s1], c = pol[l1 * NS + s0], d = pol[l1 * NS + s1], top = a + (b - a) * fs, val = top + ((c + (d - c) * fs) - top) * fl;
      val = val <= 0 ? 0 : val >= 1 ? 1 : Math.sqrt(val);
      var g = val * 255, o = lutIdx[p] * 4;
      if (colour) { var cvv = cv[(fl > 0.5 ? l1 : l0) * NS + (fs > 0.5 ? s1 : s0)]; if (cvv !== 0 && val < 0.75) { var m = Math.abs(cvv); if (cvv > 0) { data[o] = 150 + 105 * m; data[o + 1] = 20 + 200 * m * m; data[o + 2] = 20; } else { data[o] = 15; data[o + 1] = 50 + 180 * m * m; data[o + 2] = 150 + 105 * m; } continue; } }
      data[o] = g; data[o + 1] = g; data[o + 2] = g * 0.97;
    }
    bx.putImageData(img, 0, 0);
    drawOverlay();
  }
  function boxRange() {
    var b = st.box, l0 = clamp(Math.round((b.c - b.w / 2) * (NL - 1)), 0, NL - 1), l1 = clamp(Math.round((b.c + b.w / 2) * (NL - 1)), 0, NL - 1), j0 = clamp(Math.round((b.r - b.h / 2) * (NS - 1)), 0, NS - 1), j1 = clamp(Math.round((b.r + b.h / 2) * (NS - 1)), 0, NS - 1);
    return { l0: l0, l1: l1, j0: j0, j1: j1 };
  }
  function tag(t, x, y, small, spots) {
    bx.font = (small ? '700 11.5px ' : '700 13px ') + '"Figtree", Verdana, sans-serif';
    var w = bx.measureText(t).width + 10, h = small ? 17 : 19;
    x = Math.max(w / 2 + 4, Math.min(EW - w / 2 - 22, x)); y = Math.max(h, Math.min(EH - 6, y));
    for (var i = 0; i < spots.length; i++) { var s = spots[i]; if (Math.abs(s.x - x) < (s.w + w) / 2 && Math.abs(s.y - y) < h) y = s.y + h + 2; }
    spots.push({ x: x, y: y, w: w });
    bx.fillStyle = small ? 'rgba(10,19,23,.78)' : 'rgba(120,210,196,.9)'; bx.beginPath(); if (bx.roundRect) bx.roundRect(x - w / 2, y - h / 2, w, h, 4); else bx.rect(x - w / 2, y - h / 2, w, h); bx.fill();
    bx.fillStyle = small ? '#78D2C4' : '#06201C'; bx.textAlign = 'center'; bx.textBaseline = 'middle'; bx.fillText(t, x, y + 0.5); bx.textBaseline = 'alphabetic';
  }
  function polyPolar(c0, c1, r0, r1) {      // outline a polar rectangle
    var i, n = 16, q, xy; bx.beginPath();
    for (i = 0; i <= n; i++) { q = polar2plane(c0 + (c1 - c0) * i / n, r0); xy = plane2img(q[0], q[1]); if (i) bx.lineTo(xy[0], xy[1]); else bx.moveTo(xy[0], xy[1]); }
    for (i = n; i >= 0; i--) { q = polar2plane(c0 + (c1 - c0) * i / n, r1); xy = plane2img(q[0], q[1]); bx.lineTo(xy[0], xy[1]); }
    bx.closePath();
  }
  function drawOverlay() {
    var v = viewBy[st.view], i, spots = [];
    bx.save();
    bx.strokeStyle = 'rgba(120,210,196,.22)'; bx.lineWidth = 1; polyPolar(0, 1, 0, 1); bx.stroke();
    bx.fillStyle = '#A89B9C'; bx.font = '11px ui-monospace, Menlo, monospace'; bx.textAlign = 'right';
    for (var cm = 0; cm <= st.depth; cm++) { var yy = TOP + cm * 10 * ppv, big = cm % 5 === 0; bx.fillRect(EW - (big ? 12 : 7), yy - 0.5, big ? 10 : 5, 1); if (big && cm > 0) bx.fillText(cm, EW - 15, yy + 4); }
    var wTop = (G.type === 'linear' ? G.W / 2 : G.type === 'curvilinear' ? G.R * Math.sin(G.half) : 6) * ppv;
    bx.fillStyle = '#E9A23B'; bx.beginPath(); bx.arc(EW / 2 + MS * (wTop + 13), TOP - 8, 5, 0, Math.PI * 2); bx.fill();
    bx.textAlign = 'left'; bx.fillStyle = '#ECE5E4'; bx.font = '700 13px "Figtree", Verdana, sans-serif';
    var hide = st.mode === 'spot' && st.spot && !st.spot.answered;
    bx.fillText(st.mode === 'find' ? 'Find: ' + v.name : v.name, 8, 16);
    bx.font = '11px ui-monospace, Menlo, monospace'; bx.fillStyle = '#A89B9C';
    /* probe, depth and gain now read on the console strip above the image (v1.1) */
    if (st.frozen) { bx.fillStyle = '#E0A458'; bx.font = '700 12px ui-monospace, Menlo, monospace'; bx.textAlign = 'right'; bx.fillText('FROZEN', EW - 30, 16); }
    if (st.colour && cfg.flowAt) {
      var b = st.box; bx.strokeStyle = '#E0A458'; bx.lineWidth = 1.5; polyPolar(b.c - b.w / 2, b.c + b.w / 2, b.r - b.h / 2, b.r + b.h / 2); bx.stroke();
      for (i = 0; i < 60; i++) { var a = 1 - i / 30; bx.fillStyle = a > 0 ? 'rgb(' + (150 + 105 * a) + ',' + (20 + 200 * a * a) + ',20)' : 'rgb(15,' + (50 + 180 * a * a) + ',' + (150 - 105 * a) + ')'; bx.fillRect(8, 30 + i * 1.5, 9, 1.6); }
      bx.fillStyle = '#A89B9C'; bx.font = '10.5px ui-monospace, Menlo, monospace'; bx.textAlign = 'left'; bx.fillText('+' + st.scale, 20, 36); bx.fillText('−' + st.scale + ' cm/s', 20, 122);
    }
    if (st.pw && cfg.flowAt) {
      var g0 = polar2plane(st.gate.c, 0), g1 = polar2plane(st.gate.c, 1), gm = polar2plane(st.gate.c, st.gate.r), A = plane2img(g0[0], g0[1]), B = plane2img(g1[0], g1[1]), M = plane2img(gm[0], gm[1]);
      bx.strokeStyle = 'rgba(224,164,88,.75)'; bx.setLineDash([4, 4]); bx.beginPath(); bx.moveTo(A[0], A[1]); bx.lineTo(B[0], B[1]); bx.stroke(); bx.setLineDash([]);
      var dxl = B[0] - A[0], dyl = B[1] - A[1], ll = Math.hypot(dxl, dyl) || 1, nx = -dyl / ll * 8, nyy = dxl / ll * 8, ox = dxl / ll * 5, oy = dyl / ll * 5;
      bx.strokeStyle = '#E0A458'; bx.lineWidth = 2; bx.beginPath(); bx.moveTo(M[0] - ox - nx, M[1] - oy - nyy); bx.lineTo(M[0] - ox + nx, M[1] - oy + nyy); bx.moveTo(M[0] + ox - nx, M[1] + oy - nyy); bx.lineTo(M[0] + ox + nx, M[1] + oy + nyy); bx.stroke();
    }
    if (st.labels && cfg.labels) {
      for (i = 0; i < cfg.labels.length; i++) {
        var L = cfg.labels[i]; if (L.patho && hide) continue;
        var P = typeof L.p === 'function' ? L.p(S) : L.p; if (!P) continue;
        var q = world2img(P); if (q.ok && Math.abs(q.e) < (L.tol || 8)) tag(L.t, q.px, q.py, true, spots);
      }
    }
    bx.lineWidth = 1.5; bx.font = '700 12px ui-monospace, Menlo, monospace';
    for (i = 0; i < st.cal.length; i++) {
      var c = st.cal[i], p1 = plane2img(c.a[0], c.a[1]); bx.strokeStyle = bx.fillStyle = '#E0A458';
      cross2(p1[0], p1[1]);
      if (c.b) { var p2 = plane2img(c.b[0], c.b[1]); cross2(p2[0], p2[1]); bx.setLineDash([3, 3]); bx.beginPath(); bx.moveTo(p1[0], p1[1]); bx.lineTo(p2[0], p2[1]); bx.stroke(); bx.setLineDash([]); bx.textAlign = 'left'; bx.fillText('D' + c.n, p2[0] + 7, p2[1] - 5); }
    }
    if (cfg.overlay) cfg.overlay(bx, { st: st, S: S, world2img: world2img, plane2img: plane2img, EW: EW, EH: EH });
    bx.restore();
  }
  function cross2(x, y) { bx.beginPath(); bx.moveTo(x - 6, y); bx.lineTo(x + 6, y); bx.moveTo(x, y - 6); bx.lineTo(x, y + 6); bx.stroke(); }

  /* ---------------- pulsed-wave spectral strip */
  var sc, sx, SW = 512, SH = 120, sxPos = 0, pwBuf = [], pwStats = null;
  function gateInfo() {
    var q = polar2plane(st.gate.c, st.gate.r), l = clamp(Math.round(st.gate.c * (NL - 1)), 0, NL - 1), j = clamp(Math.round(st.gate.r * (NS - 1)), 0, NS - 1), k = l * 3, dr = G.D / (NS - 1);
    var e = [LDx[k], LDx[k + 1], LDx[k + 2]], p = [LOx[k] + e[0] * dr * j, LOx[k + 1] + e[1] * dr * j, LOx[k + 2] + e[2] * dr * j], id = ids[l * NS + j], vb = 0, ang = null, has = false;
    if (cfg.flowAt && tFlow[id] && cfg.flowAt(p[0], p[1], p[2], st.t, S, id, fv)) { var sp = Math.hypot(fv[0], fv[1], fv[2]); vb = -(fv[0] * e[0] + fv[1] * e[1] + fv[2] * e[2]); if (sp > 1e-6) { ang = Math.acos(clamp(Math.abs(vb) / sp, 0, 1)) * R2D; has = true; } }
    return { p: p, e: e, id: id, vb: vb, angle: ang, has: has, plane: q };
  }
  function drawPW(dt) {
    var gi = gateInfo(), ny = st.scale, base = SH * 0.72, pxs = 110, x0 = sxPos, x1 = sxPos + dt * pxs, x, cyc = cfg.cycle || 1;
    var velAt = function (t) { return cfg.flowAt(gi.p[0], gi.p[1], gi.p[2], t, S, gi.id, fv) ? -(fv[0] * gi.e[0] + fv[1] * gi.e[1] + fv[2] * gi.e[2]) : 0; };
    for (x = Math.floor(x0); x < Math.floor(x1); x++) {
      var tc = st.t - dt + dt * (x + 1 - x0) / (x1 - x0); if (gi.has) gi.vb = velAt(tc);     // one time sample per strip column, so the systolic peak is not missed between frames
      pwBuf.push([tc, gi.has ? Math.abs(gi.vb) : -1]);
      var xx = x % SW; sx.fillStyle = '#000'; sx.fillRect(xx, 0, 2, SH); sx.fillStyle = '#2C2729'; sx.fillRect((xx + 6) % SW, 0, 2, SH);
      sx.fillStyle = 'rgba(157,178,180,.5)'; sx.fillRect(xx, base, 1, 1);
      if (gi.has) {
        var vv = gi.vb, a = Math.abs(vv), yT = base - vv / ny * (SH * 0.62), yB = base - vv * 0.55 / ny * (SH * 0.62), y;
        for (y = Math.min(yT, yB); y <= Math.max(yT, yB); y++) { var yw = y; if (yw < 0) yw += SH; if (yw >= SH) yw -= SH; var gl = 120 + 135 * rnd(); sx.fillStyle = 'rgb(' + gl + ',' + gl + ',' + gl + ')'; sx.fillRect(xx, yw, 1, 1); }
        if (a > 0) { for (y = 0; y < 3; y++) { sx.fillStyle = 'rgba(200,200,200,' + (0.25 * rnd()) + ')'; sx.fillRect(xx, base - vv * rnd() * 0.5 / ny * (SH * 0.62), 1, 1); } }
      } else if (rnd() < 0.5) { sx.fillStyle = 'rgba(160,160,160,.35)'; sx.fillRect(xx, base + (rnd() - 0.5) * 5, 1, 1); }
    }
    sxPos = x1 % SW;
    while (pwBuf.length && pwBuf[0][0] < st.t - cyc * 1.05) pwBuf.shift();
    pwStats = null;
    if (pwBuf.length > 8 && st.t - pwBuf[0][0] >= cyc * 0.95 && pwBuf.every(function (b) { return b[1] >= 0; })) {
      var mx = 0, mn = 1e9; pwBuf.forEach(function (b) { if (b[1] > mx) mx = b[1]; if (b[1] < mn) mn = b[1]; });
      pwStats = { psv: mx, edv: mn, ri: mx > 0 ? (mx - mn) / mx : 0, angle: gi.angle, id: gi.id };
    }
    var txt = gi.has ? 'Beam-to-flow angle ' + Math.round(gi.angle) + '°' : 'Gate is not in a vessel: tap the image to place it';
    if (pwStats) { txt += ' · max ' + pwStats.psv.toFixed(0) + ' · min ' + pwStats.edv.toFixed(0) + ' cm/s (beam component)'; if (cfg.pw && cfg.pw.ri) txt += ' · RI ' + pwStats.ri.toFixed(2); }
    if (cfg.pw && cfg.pw.readout) txt = cfg.pw.readout(pwStats, gi, S) || txt;
    ui.pwInfo.textContent = txt;
  }

  /* ---------------- 3D pane */
  var T3 = null, NOGL = !!qs.get('nogl');          // T3 is set once three.js has loaded (loadThree); ?nogl=1 forces the no-WebGL fallback (for testing)
  var renderer = null, scene = null, camera = null, root = null, scene3 = null, probeG = null, fanMesh = null, fanLine = null, clipPlane = null, mats = [], cam = { theta: 0.5, phi: 0.5, dist: 700, target: null }, camAnim = null, giz, gzc;
  function v3(a) { return new T3.Vector3(a[0], a[1], a[2]); }
  function init3D() {
    if (!T3) return false;
    try { renderer = new T3.WebGLRenderer({ canvas: ui.gl, antialias: true, alpha: false, powerPreference: 'low-power' }); } catch (e) { renderer = null; return false; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); renderer.setClearColor(0x0D0C0D, 1); renderer.localClippingEnabled = true;
    scene = new T3.Scene(); camera = new T3.PerspectiveCamera(34, 4 / 3, 5, 6000); cam.target = new T3.Vector3();
    root = new T3.Group(); if (cfg.posture !== 'upright') root.rotation.x = -Math.PI / 2; scene.add(root); root.updateMatrixWorld(true);
    clipPlane = new T3.Plane(new T3.Vector3(0, 0, 1), 0);
    var ctx = {
      THREE: T3, root: root,
      mat: function (color, o) { o = o || {}; var m = new T3.MeshStandardMaterial({ color: color, roughness: o.roughness == null ? 0.6 : o.roughness, metalness: 0.05, transparent: o.opacity != null && o.opacity < 1, opacity: o.opacity == null ? 1 : o.opacity, side: o.double ? T3.DoubleSide : T3.FrontSide, depthWrite: !(o.opacity != null && o.opacity < 0.6) }); if (!o.noClip) mats.push(m); return m; },
      ellipsoid: function (center, semi, fr, material) { var m = new T3.Mesh(new T3.SphereGeometry(1, 28, 20), material); ctx.place(m, center, semi, fr); root.add(m); return m; },
      place: function (m, center, semi, fr) { var L = fr ? fr.L : [1, 0, 0], M = fr ? fr.M : [0, 1, 0], Tt = fr ? fr.T : [0, 0, 1]; m.matrixAutoUpdate = false; m.matrix.makeBasis(v3(mul(L, semi[0])), v3(mul(M, semi[1])), v3(mul(Tt, semi[2]))); m.matrix.setPosition(v3(center)); m.matrixWorldNeedsUpdate = true; },
      tube: function (pts, r, material, closed) { var c = new T3.CatmullRomCurve3(pts.map(v3)), m = new T3.Mesh(new T3.TubeGeometry(c, Math.max(8, pts.length * 6), r, 10, !!closed), material); root.add(m); return m; },
      add: function (m) { root.add(m); return m; }
    };
    scene3 = cfg.scene ? (cfg.scene(ctx) || {}) : {};
    fanMesh = new T3.Mesh(new T3.BufferGeometry(), new T3.MeshBasicMaterial({ color: 0x78D2C4, transparent: true, opacity: 0.2, side: T3.DoubleSide, depthWrite: false }));
    fanLine = new T3.Line(new T3.BufferGeometry(), new T3.LineBasicMaterial({ color: 0x78D2C4, transparent: true, opacity: 0.95 }));
    fanMesh.renderOrder = 5; root.add(fanMesh, fanLine);
    probeG = new T3.Group(); root.add(probeG); buildProbe();
    scene.add(new T3.AmbientLight(0xffffff, 0.75)); var dl = new T3.DirectionalLight(0xffffff, 1.2); dl.position.set(300, 600, 400); scene.add(dl);
    giz = ui.giz; gzc = giz.getContext('2d');
    setupPointer(); resize3D();
    if (window.ResizeObserver) new ResizeObserver(resize3D).observe(ui.stage); else window.addEventListener('resize', resize3D);
    ui.gl.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });
    ui.gl.addEventListener('webglcontextrestored', function () { dirty3 = true; });
    return true;
  }
  function buildProbe() {
    if (!probeG) return; while (probeG.children.length) probeG.remove(probeG.children[0]);
    var p = probe(), w = p.type === 'curvilinear' ? 2 * (p.radius || 60) * Math.sin((p.fov || 70) / 2 * D2R) : p.type === 'linear' ? (p.width || 40) : 22, th = p.type === 'sector' ? 16 : 13;
    var bodyM = new T3.MeshStandardMaterial({ color: 0xD8DEE0, roughness: 0.45, metalness: 0.1 }), faceM = new T3.MeshStandardMaterial({ color: 0x2A3238, roughness: 0.7 });
    var face = new T3.Mesh(new T3.BoxGeometry(w, 5, th), faceM); face.position.y = 2.5; probeG.add(face);
    var neck = new T3.Mesh(new T3.CylinderGeometry(0.5, 0.5, 1, 20), bodyM); neck.scale.set(w * 0.9, 34, th * 1.5); neck.position.y = 22; probeG.add(neck);
    var grip = new T3.Mesh(new T3.CylinderGeometry(9, 12, 60, 18), bodyM); grip.scale.set(1.15, 1, 0.8); grip.position.y = 66; probeG.add(grip);
    var mk = new T3.Mesh(new T3.SphereGeometry(4.2, 16, 12), new T3.MeshBasicMaterial({ color: 0xE9A23B })); mk.position.set(w / 2 + 1, 12, 0); probeG.add(mk);
    var ridge = new T3.Mesh(new T3.BoxGeometry(3, 44, 3), new T3.MeshBasicMaterial({ color: 0xE9A23B })); ridge.position.set(w * 0.45 + 2, 30, 0); probeG.add(ridge);
    probeG.matrixAutoUpdate = false;
  }
  function resize3D() { if (!renderer) return; var r = ui.stage.getBoundingClientRect(); if (!r.width || !r.height) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); dirty3 = true; }
  function updateScenePose() {
    if (!renderer || !pose) return;
    var seg = 32, pos = [], line = [], idx = [], i, f, o, e, D = G.D, lin = G.type === 'linear';
    var org = function (fr) { if (lin) return add(pose.O, mul(pose.u, (fr - 0.5) * G.W)); var th = -G.half + 2 * G.half * fr, d = add(mul(pose.n, Math.cos(th)), mul(pose.u, Math.sin(th))); return [add(pose.O, mul(sub(d, pose.n), G.R)), d]; };
    var topPts = [], botPts = [];
    for (i = 0; i <= seg; i++) { f = i / seg; if (lin) { o = org(f); e = add(o, mul(pose.n, D)); } else { var od = org(f); o = od[0]; e = add(o, mul(od[1], D)); } topPts.push(o); botPts.push(e); pos.push(o[0], o[1], o[2], e[0], e[1], e[2]); if (i < seg) { var a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    topPts.forEach(function (p) { line.push(p[0], p[1], p[2]); }); botPts.reverse().forEach(function (p) { line.push(p[0], p[1], p[2]); }); line.push(topPts[0][0], topPts[0][1], topPts[0][2]);
    fanMesh.geometry.dispose(); fanMesh.geometry = new T3.BufferGeometry(); fanMesh.geometry.setAttribute('position', new T3.Float32BufferAttribute(pos, 3)); fanMesh.geometry.setIndex(idx);
    fanLine.geometry.dispose(); fanLine.geometry = new T3.BufferGeometry(); fanLine.geometry.setAttribute('position', new T3.Float32BufferAttribute(line, 3));
    fanMesh.visible = fanLine.visible = st.fan;
    var yA = v3(mul(pose.n, -1)), xA = v3(pose.u), zA = new T3.Vector3().crossVectors(xA, yA);
    probeG.matrix.makeBasis(xA, yA, zA); probeG.matrix.setPosition(v3(pose.O)); probeG.matrixWorldNeedsUpdate = true;
    dirty3 = true;
  }
  function toWorld(a) { return v3(a).applyMatrix4(root.matrixWorld); }
  function dirWorld(a) { return v3(a).transformDirection(root.matrixWorld); }
  function frameCamera(animate) {
    if (!renderer || !pose) return;
    var vw = viewBy[st.view], c = vw.cam || {}, tgt = toWorld(add(pose.O, mul(pose.n, 80)));
    var out = dirWorld(mul(basisAt(pose.O).n0, -1)), d = new T3.Vector3(out.x, out.y + 0.6, out.z + 0.3).normalize();   // from the probe's side, raised, slightly from the feet
    var to = { theta: c.theta != null ? c.theta : Math.atan2(d.x, d.z), phi: c.phi != null ? c.phi : Math.asin(clamp(d.y, -0.95, 0.95)), dist: c.dist || cfg.camDist || 820, target: tgt };
    if (animate && !REDUCED) camAnim = { from: { theta: cam.theta, phi: cam.phi, dist: cam.dist, target: cam.target.clone() }, to: to, t: 0 };
    else { cam.theta = to.theta; cam.phi = to.phi; cam.dist = to.dist; cam.target.copy(tgt); }
    dirty3 = true;
  }
  function setupPointer() {
    var pts = new Map(), mode = null, ray = new T3.Raycaster(), ndc = new T3.Vector2(), lastAng = null, gl = ui.gl, pen = null, ghost = null;
    function cast(e, objs) { var r = gl.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1)); ray.setFromCamera(ndc, camera); return ray.intersectObjects(objs, true); }
    function slideTo(e) { if (!scene3.skin) return false; var h = cast(e, [scene3.skin]); if (!h.length) return false; var p = root.worldToLocal(h[0].point.clone()); setO([p.x, p.y, p.z]); return true; }
    /* Apple Pencil 2 / Pro through Pointer Events: the tip places the probe, leaning it fans and rocks (relative to how it was held
       at touch-down), pressure compresses and couples, barrel roll (twist, where the browser reports it) rotates, and hover shows
       where the probe will land. Fingers keep orbit and pinch; touches are ignored while the Pencil is down (palm rejection). */
    function penAngles(e) {
      var tx = e.tiltX, ty = e.tiltY;
      if ((tx == null || (!tx && !ty)) && e.altitudeAngle != null && e.altitudeAngle < Math.PI / 2 - 1e-3) { var t = Math.tan(e.altitudeAngle); tx = Math.atan(Math.cos(e.azimuthAngle || 0) / t) * R2D; ty = Math.atan(Math.sin(e.azimuthAngle || 0) / t) * R2D; }
      return [tx || 0, ty || 0];
    }
    function penPress(raw) {
      var m = clamp(((raw || 0) - 0.04) / 0.76, 0, 1); st.pen.p += (m - st.pen.p) * 0.4; if (Math.abs(st.pen.p - m) < 0.01) st.pen.p = m;
      var q = Math.round(st.pen.p * 20) / 20; if (q !== st.pen.sent) { st.pen.sent = q; applyPress(q); }
      dirty2 = true;
    }
    function penAim(e) {
      var a = penAngles(e);
      st.rock = clamp(Math.round(pen.rock0 + (a[0] - pen.a0[0])), -45, 45); st.tilt = clamp(Math.round(pen.tilt0 - (a[1] - pen.a0[1])), -60, 60);
      if (e.twist != null && pen.tw0 != null && e.twist !== pen.tw0) st.rot = wrap180(pen.rot0 + wrap180(e.twist - pen.tw0));
      poseDirty = dirty2 = true;
    }
    function showGhost(e) {
      if (!scene3.skin) return; var h = cast(e, [scene3.skin]);
      if (!ghost) { ghost = new T3.Mesh(new T3.SphereGeometry(5, 16, 12), new T3.MeshBasicMaterial({ color: 0x78D2C4, transparent: true, opacity: 0.6, depthTest: false })); ghost.renderOrder = 9; root.add(ghost); }
      if (h.length) { var p = root.worldToLocal(h[0].point.clone()); ghost.position.copy(p); ghost.visible = true; } else ghost.visible = false;
      dirty3 = true;
    }
    function hideGhost() { if (ghost && ghost.visible) { ghost.visible = false; dirty3 = true; } }
    gl.addEventListener('pointerdown', function (e) {
      if (pen && e.pointerType !== 'pen') return;                     // palm rejection
      if (e.pointerType === 'pen') {
        markPen(); hideGhost();
        if (cast(e, [scene3.skin || probeG]).length && scene3.skin) {
          pts.clear(); try { gl.setPointerCapture(e.pointerId); } catch (er) {} camAnim = null;
          pen = { id: e.pointerId, a0: penAngles(e), tilt0: st.tilt, rock0: st.rock, rot0: st.rot, tw0: e.twist != null ? e.twist : null };
          st.pen.on = true; mode = 'pen'; slideTo(e); penPress(e.pressure); syncSliders(); penChip(); gl.style.cursor = 'none';
          return;
        }
      }
      try { gl.setPointerCapture(e.pointerId); } catch (er) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); camAnim = null; lastAng = null;
      if (pts.size === 1) { mode = (st.drag === 'probe' || cast(e, [probeG]).length) ? 'probe' : 'orbit'; if (mode === 'probe' && st.drag === 'probe') slideTo(e); gl.style.cursor = mode === 'probe' ? 'move' : 'grabbing'; }
    });
    gl.addEventListener('pointermove', function (e) {
      if (pen && e.pointerId === pen.id) {
        var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null, le = evs && evs.length ? evs[evs.length - 1] : e;
        slideTo(le); penAim(le); penPress(le.pressure); syncSliders(); penChip(); return;
      }
      if (e.pointerType === 'pen' && !e.buttons && !pen) { markPen(); showGhost(e); return; }   // hover (Pencil Pro, Pencil 2 on M2 iPad Pro)
      if (!pts.has(e.pointerId)) return; var p = pts.get(e.pointerId);
      if (pts.size === 2) {
        var arr = Array.from(pts.values()), d0 = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y); p.x = e.clientX; p.y = e.clientY;
        arr = Array.from(pts.values()); var d1 = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y), ang = Math.atan2(arr[1].y - arr[0].y, arr[1].x - arr[0].x);
        if (mode === 'probe') { if (lastAng != null) { var da = ang - lastAng; da = Math.atan2(Math.sin(da), Math.cos(da)); setAdj('rot', wrap180(st.rot + da * R2D)); } lastAng = ang; }
        else { cam.dist = clamp(cam.dist * d0 / (d1 || 1), 180, 1800); dirty3 = true; }
        return;
      }
      if (mode === 'probe') slideTo(e);
      else { cam.theta -= (e.clientX - p.x) * 0.008; cam.phi = clamp(cam.phi + (e.clientY - p.y) * 0.008, -1.45, 1.45); dirty3 = true; }
      p.x = e.clientX; p.y = e.clientY;
    });
    var up = function (e) {
      if (pen && e.pointerId === pen.id) { pen = null; mode = null; st.pen.on = false; st.pen.p = 0; st.pen.sent = 0; applyPress(0); penChip(); dirty2 = true; gl.style.cursor = st.drag === 'probe' ? 'move' : 'grab'; return; }   // lifting the probe releases the pressure
      pts.delete(e.pointerId); lastAng = null; if (!pts.size && !pen) { mode = null; gl.style.cursor = st.drag === 'probe' ? 'move' : 'grab'; }
    };
    gl.addEventListener('pointerup', up); gl.addEventListener('pointercancel', up); gl.addEventListener('pointerleave', function (e) { if (e.pointerType === 'pen' && !pen) hideGhost(); });
    gl.addEventListener('wheel', function (e) { e.preventDefault(); if (st.drag === 'probe') setAdj('rot', wrap180(st.rot + (e.deltaY > 0 ? 3 : -3))); else { cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 180, 1800); dirty3 = true; } }, { passive: false });
  }
  /* pressure from the Pencil: a sim either takes it through cfg.onPress, or has a 'press' parameter (0..1) that its anatomy already reads */
  function applyPress(v) {
    if (cfg.onPress) cfg.onPress(v, api);
    else if ((cfg.params || []).some(function (p) { return p.id === 'press'; })) { if ((params.press || 0) === v) return; params.press = v; rebuildS(); if (psl && psl.press) psl.press.sync(); }
  }
  function markPen() { if (st.pen.seen) return; st.pen.seen = true; if (ui.penChip) ui.penChip.hidden = false; }
  function penChip() {
    if (!ui.penChip) return; var p = st.pen.p, w = p < 0.05 ? 'floating' : p < 0.4 ? 'light' : p < 0.75 ? 'moderate' : 'firm';
    ui.penChip.textContent = st.pen.on ? 'Pencil · ' + w + ' pressure · fan ' + Math.round(st.tilt) + '° · rock ' + Math.round(st.rock) + '°' : 'Pencil ready · touch the skin to scan';
  }
  function wrap180(a) { return ((a + 180) % 360 + 360) % 360 - 180; }
  function render3D() {
    if (!renderer) return;
    if (camAnim) {
      camAnim.t = Math.min(1, camAnim.t + 0.07); var k = 1 - Math.pow(1 - camAnim.t, 3), a = camAnim.from, b = camAnim.to, dth = b.theta - a.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
      cam.theta = a.theta + dth * k; cam.phi = a.phi + (b.phi - a.phi) * k; cam.dist = a.dist + (b.dist - a.dist) * k; cam.target.lerpVectors(a.target, b.target, k); dirty3 = true; if (camAnim.t >= 1) camAnim = null;
    }
    if (!dirty3) return; dirty3 = false;
    var cp = Math.cos(cam.phi);
    camera.position.set(cam.target.x + cam.dist * cp * Math.sin(cam.theta), cam.target.y + cam.dist * Math.sin(cam.phi), cam.target.z + cam.dist * cp * Math.cos(cam.theta));
    camera.lookAt(cam.target); camera.updateMatrixWorld();
    if (pose) {
      var Nw = dirWorld(pose.N), Ow = toWorld(pose.O), side = new T3.Vector3().subVectors(camera.position, Ow).dot(Nw) > 0 ? -1 : 1;
      clipPlane.setFromNormalAndCoplanarPoint(Nw.multiplyScalar(side), Ow);
      for (var i = 0; i < mats.length; i++) mats[i].clippingPlanes = st.cut ? [clipPlane] : null;
    }
    renderer.render(scene, camera);
    var W = giz.width, c = W / 2, R = W * 0.3, m = camera.matrixWorldInverse.elements, items = [];
    gzc.clearRect(0, 0, W, W);
    [['L', 'R', [1, 0, 0], '#E9A23B'], ['S', 'I', [0, 1, 0], '#ECE5E4'], ['A', 'P', [0, 0, 1], '#78D2C4']].forEach(function (ax) {
      var w = dirWorld(ax[2]), x = m[0] * w.x + m[4] * w.y + m[8] * w.z, y = m[1] * w.x + m[5] * w.y + m[9] * w.z, z = m[2] * w.x + m[6] * w.y + m[10] * w.z;
      items.push({ x: x, y: y, z: z, lab: ax[0], col: ax[3], neg: false }, { x: -x, y: -y, z: -z, lab: ax[1], col: ax[3], neg: true });
    });
    items.sort(function (a2, b2) { return a2.z - b2.z; });
    gzc.font = '700 22px "Figtree", Verdana, sans-serif'; gzc.textAlign = 'center'; gzc.textBaseline = 'middle';
    items.forEach(function (it) { gzc.globalAlpha = it.neg ? 0.45 : 1; gzc.strokeStyle = it.col; gzc.lineWidth = 3; gzc.beginPath(); gzc.moveTo(c, c); gzc.lineTo(c + it.x * R, c - it.y * R); gzc.stroke(); gzc.fillStyle = it.col; gzc.fillText(it.lab, c + it.x * (R + 17), c - it.y * (R + 17)); });
    gzc.globalAlpha = 1;
  }

  /* ---------------- anatomy models (glTF context layer; the B-mode never reads them) */
  var anat = { on: false, op: (cfg.anatomy && cfg.anatomy.opacity) || 0.6, group: null, items: [], mats: [], parts: {}, loaded: false };
  function anatBox(obj) { obj.updateMatrixWorld(true); return new T3.Box3().setFromObject(obj); }      // obj not yet parented: its own model space
  /* fit(obj, opts): uniform scale and translate so the model's box lands in sim mm space.
     opts: scale (number) or width / height / depth (target box size along x / y / z, mm); center [x,y,z] target for the box centre
     (or top / bottom: target y of the box top / bottom, with cx, cz). Optional rotateY / rotateX (radians) applied first. */
  function anatFit(obj, o) {
    if (o.rotateX) obj.rotation.x = o.rotateX; if (o.rotateY) obj.rotation.y = o.rotateY; obj.scale.setScalar(1); obj.position.set(0, 0, 0);
    var b = anatBox(obj), sz = b.getSize(new T3.Vector3()), c = b.getCenter(new T3.Vector3());
    var k = o.scale || (o.width ? o.width / sz.x : o.height ? o.height / sz.y : o.depth ? o.depth / sz.z : 1000);
    obj.scale.setScalar(k);
    var tgt = o.center ? new T3.Vector3(o.center[0], o.center[1], o.center[2]) : new T3.Vector3(o.cx || 0, o.top != null ? o.top - sz.y * k / 2 : o.bottom != null ? o.bottom + sz.y * k / 2 : 0, o.cz || 0);
    obj.position.set(tgt.x - c.x * k, tgt.y - c.y * k, tgt.z - c.z * k); obj.updateMatrixWorld(true);
    return { scale: k, box: b };
  }
  function credLine(c, html) {
    if (!html) return c.title + ' by ' + c.author + ' (' + c.licence + ')';
    return '<b>' + esc(c.title) + '</b> by ' + esc(c.author) + ' · <a href="' + esc(c.licenceUrl || '#') + '" target="_blank" rel="noopener">' + esc(c.licence) + '</a> · <a href="' + esc(c.source) + '" target="_blank" rel="noopener">source</a>' + (c.changes ? '<br><span>' + esc(c.changes) + '</span>' : '');
  }
  function setAnat(on) {
    if (!anat.loaded) return; anat.on = !!on; anat.group.visible = anat.on;
    if (ui.bAnat) { ui.bAnat.setAttribute('aria-pressed', anat.on ? 'true' : 'false'); }
    try { if (scene3 && scene3.anatomy) scene3.anatomy(anat.on, anatApi); if (cfg.anatomy.toggle) cfg.anatomy.toggle(anat.on, anatApi); } catch (e) { if (window.console) console.warn('PBSim anatomy toggle', e); }
    dirty3 = true;
  }
  function setAnatOpacity(v) {
    anat.op = v; anat.mats.forEach(function (m) { var o = Math.min(1, v * m.userData.k); m.opacity = o; m.transparent = o < 0.999; m.depthWrite = o >= 0.45; m.needsUpdate = true; }); dirty3 = true;
  }
  var anatApi = null;
  function anatUpdate() { if (anat.loaded && cfg.anatomy.update) { try { cfg.anatomy.update(S, st.reveal, anatApi); } catch (e) { if (window.console) console.warn('PBSim anatomy update', e); } dirty3 = true; } }
  function loadAnatomy() {
    var A = cfg.anatomy; if (!A || !A.models || !A.models.length || !renderer) return;
    if (!T3.GLTFLoader) { if (window.console) console.info('PBSim: GLTFLoader unavailable (legacy three.js global); anatomy models skipped.'); return; }
    var loader = new T3.GLTFLoader(), grp = new T3.Group(); grp.name = 'anatomy'; grp.visible = false;
    var jobs = A.models.map(function (m) { return new Promise(function (res) { try { pbLoadGLB(m.url, loader, function (g) { res({ m: m, obj: g.scene }); }, function (e) { res({ m: m, err: e }); }); } catch (e) { res({ m: m, err: e }); } }); });
    Promise.all(jobs).then(function (list) {
      var ok = list.filter(function (x) { return !x.err; });
      list.forEach(function (x) { if (x.err && window.console) console.warn('PBSim: anatomy model not loaded: ' + x.m.url); });
      if (!ok.length) return;
      try {
        anatApi = { THREE: T3, root: root, group: grp, parts: anat.parts, items: anat.items, fit: anatFit, box: anatBox, api: api, kit: anatKit(T3, root, grp) };
        ok.forEach(function (it) {
          var m = it.m, obj = it.obj; obj.name = m.id;
          obj.traverse(function (c) {
            if (!c.isMesh) return; c.name = String(c.name || '').replace(/_/g, ' ');   // GLTFLoader sanitises node names (spaces become _): restore them
            var hasVC = !!c.geometry.attributes.color, sty = (m.style && m.style(c.name || '', c)) || {}, k = sty.opacity == null ? 1 : sty.opacity;
            var mat = new T3.MeshStandardMaterial({ color: sty.color != null ? sty.color : (hasVC ? 0xffffff : 0xD9C7B0), vertexColors: hasVC && sty.color == null, roughness: sty.roughness == null ? 0.62 : sty.roughness, metalness: sty.metalness || 0.02, side: T3.DoubleSide });
            mat.userData.k = k; c.material = mat; anat.mats.push(mat); mats.push(mat); c.renderOrder = 2; if (sty.hide) c.visible = false;
            var key = m.id + ':' + (c.name || 'mesh'), n = 1; while (anat.parts[key]) key = m.id + ':' + (c.name || 'mesh') + '#' + (++n); anat.parts[key] = c;
          });
          if (m.fit) { if (typeof m.fit === 'function') m.fit(obj, anatApi); else anatFit(obj, m.fit); }
          anat.items.push({ m: m, obj: obj }); grp.add(obj);
        });
        root.add(grp); anat.group = grp; root.updateMatrixWorld(true);
        if (A.onLoad) A.onLoad(anatApi);
        anat.loaded = true; setAnatOpacity(anat.op);
        /* keys, opacity fader, credits */
        if (ui.bAnat) ui.bAnat.hidden = false; if (ui.bCred) ui.bCred.hidden = false;
        var g = document.getElementById('pbc-g-anat'); if (g) { g.hidden = false; slider(ui.slAnat, 'anatop', 'Model opacity', 0.1, 1, 0.05, function () { return anat.op; }, setAnatOpacity, function (v) { return Math.round(v * 100) + '%'; }); }
        var used = ok.map(function (x) { return x.m; }).filter(function (m) { return m.credit; });
        ui.cred.innerHTML = '<button type="button" aria-label="Close credits">×</button><h3>3D models</h3><ul>' + used.map(function (m) { return '<li>' + credLine(m.credit, true) + '</li>'; }).join('') + '</ul><p>Shown for orientation only. Converted for the web (decompressed, simplified, quantized); see CREDITS.md in the Bench sources. The ultrasound image is computed from the simulator’s own modelled anatomy, not from these meshes.</p>';
        ui.cred.querySelector('button').addEventListener('click', function () { ui.cred.hidden = true; if (ui.bCred) ui.bCred.setAttribute('aria-expanded', 'false'); });
        var fl = document.getElementById('pb-mcredline'); if (fl) fl.innerHTML = '3D models: ' + used.map(function (m) { return credLine(m.credit, true).replace(/<br>.*$/, ''); }).join('; ') + '.';
        anatUpdate(); setAnat(A.defaultOn !== false);
      } catch (e) { if (window.console) console.warn('PBSim: anatomy layer disabled', e); try { root.remove(grp); } catch (er) {} anat.loaded = false; }
    });
  }

  /* ---------------- scoring */
  function angErr(P, Tg, flipOK) {
    var ne = Math.acos(clamp(Math.abs(dot(P.N, Tg.N)), 0, 1)) * R2D, up = sub(Tg.u, mul(P.N, dot(Tg.u, P.N))), re = 0;
    if (len(up) > 1e-4) { re = Math.acos(clamp(dot(P.u, nrm(up)), -1, 1)) * R2D; if (flipOK && re > 90) re = 180 - re; }
    return { n: ne, r: re };
  }
  function dirWord(v) { var ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]); if (ay >= ax && ay >= az) return AX.y[v[1] > 0 ? 0 : 1]; if (ax >= az) return AX.x[v[0] > 0 ? 0 : 1]; return AX.z[v[2] > 0 ? 0 : 1]; }
  function evalView() {
    var vw = viewBy[st.view], tol = vw.tol || {}, tn = tol.normal || 10, tr = tol.rot || 15, tp = tol.slide || 10;
    var a = angErr(pose, target, vw.flipOK), pe = len(sub(pose.O, target.O)), checks = [], i;
    (vw.require || []).forEach(function (rq) {
      var ok = true;
      if (rq.ids) { var c = 0; rq.ids.forEach(function (id) { c += hist[id]; }); ok = c / histN >= (rq.min || 0.01); }
      else if (rq.pt) { var P = typeof rq.pt === 'function' ? rq.pt(S) : rq.pt, q = world2img(P); ok = q.ok && Math.abs(q.e) <= (rq.within || 8); if (ok && rq.mid) ok = q.r >= 0.2 && q.r <= 0.8; }
      checks.push({ ok: ok, label: rq.label, hint: rq.hint });
    });
    if (vw.check) (vw.check({ st: st, S: S, pose: pose, target: target, hist: hist, histN: histN, pw: pwStats, world2img: world2img, gate: st.pw ? gateInfo() : null }) || []).forEach(function (c) { checks.push(c); });
    var okN = a.n <= tn, okR = a.r <= tr, okP = pe <= tp, okC = checks.every(function (c) { return c.ok; }), hint = '';
    var slideTxt = 'Slide the probe about <b>' + (pe / 10).toFixed(1) + ' cm</b> toward ' + dirWord(sub(target.O, pose.O)) + '.';
    /* best single-control correction: line search on rotate, tilt and rock (coarse, then 1 degree steps) */
    var best = null, cur = a.n + a.r, adjTxt = '';
    var trial = function (k, dl) { var r = st.rot, ti = st.tilt, rk = st.rock; if (k === 'rot') r += dl; else if (k === 'tilt') ti += dl; else rk += dl; var e = angErr(poseFrom(st.O, r, ti, rk), target, vw.flipOK), tot = e.n + e.r + Math.abs(dl) * 0.02; if (!best || tot < best.tot) best = { k: k, d: dl, tot: tot }; };
    if (!okP) hint = slideTxt;
    else {
      [['rot', 180, 6], ['tilt', 60, 4], ['rock', 44, 4]].forEach(function (pr) { for (var dl = -pr[1]; dl <= pr[1]; dl += pr[2]) if (dl) trial(pr[0], dl); });
      if (best) { var bk = best.k, bd = best.d; for (var f = bd - 5; f <= bd + 5; f++) if (f) trial(bk, f); }
      if (!(best && best.tot < cur - 1) && (!okN || !okR)) {      // no single control helps: fall back to the exact difference in probe angles
        var tu = (vw.flipOK && dot(target.u, pose.u) < 0) ? mul(target.u, -1) : target.u, q = paramsFrom(pose.O, target.n, tu);
        var dq = [['rot', wrap180(q.rot - st.rot)], ['tilt', q.tilt - st.tilt], ['rock', q.rock - st.rock]].sort(function (x, y) { return Math.abs(y[1]) - Math.abs(x[1]); })[0];
        if (Math.abs(dq[1]) >= 1) best = { k: dq[0], d: Math.round(dq[1]), tot: -1 };
      }
      if (best && best.tot < cur - 1) {
        var ad = Math.abs(best.d);
        if (best.k === 'rot') adjTxt = 'Rotate the probe about <b>' + ad + '° ' + (best.d > 0 ? 'clockwise' : 'counter-clockwise') + '</b> (seen from the cable end).';
        else if (best.k === 'tilt') adjTxt = 'Tilt (fan) about <b>' + ad + '°</b> so the beam sweeps toward ' + dirWord(mul(pose.N, best.d > 0 ? -1 : 1)) + '.';
        else adjTxt = 'Rock about <b>' + ad + '°</b> so the beam points ' + (best.d > 0 ? 'toward' : 'away from') + ' the index-marker side.';
      }
      if (!okN || !okR) hint = adjTxt || 'Small adjustments: fan and rotate until the bars turn green.';
      else if (!okC) { var fc = checks.filter(function (c) { return !c.ok; })[0]; hint = (fc.hint || ('Not yet: ' + fc.label + '.')) + (adjTxt ? ' Try: ' + adjTxt : pe > 4 ? ' Try: ' + slideTxt : ''); }
      else hint = '<b>Window found.</b> Hold it steady.';
    }
    metrics = { n: a.n, r: a.r, p: pe, tn: tn, tr: tr, tp: tp, ok: okN && okR && okP && okC, checks: checks, hint: hint, score: Math.max(0, Math.round(100 - 50 * (a.n / tn + a.r / tr + pe / tp) / 3)) };
    return metrics;
  }
  function updateCoach(dt) {
    if (!pose) return; var m = evalView(), f = st.find, hold = viewBy[st.view].hold || cfg.hold || 1.5;
    var set = function (row, val, tol, txt) { row.className = 'pb-bar' + (val <= tol ? ' ok' : ''); row.querySelector('i').style.width = clamp(val / (3 * tol) * 100, 2, 100) + '%'; row.querySelector('.val').textContent = txt; };
    set(ui.barN, m.n, m.tn, m.n.toFixed(0) + '°'); set(ui.barR, m.r, m.tr, m.r.toFixed(0) + '°'); set(ui.barP, m.p, m.tp, m.p.toFixed(0) + ' mm');
    var rq = m.checks.map(function (c) { return '<li class="' + (c.ok ? 'ok' : '') + '">' + esc(c.label) + '</li>'; }).join(''); if (ui.req.innerHTML !== rq) ui.req.innerHTML = rq;
    if (m.ok && !st.frozen) f.hold += dt; else if (!m.ok) f.hold = 0;
    ui.holdBar.style.width = clamp(f.hold / hold * 100, 0, 100) + '%';
    var hint = m.hint;
    if (st.mode === 'find' && m.ok && f.hold >= hold && !f.done) {
      f.done = true; var secs = Math.round((performance.now() - f.t0) / 1000);
      if (!f.shown) { var prev = prog.views[st.view]; if (!prev || m.score >= (prev.score || 0)) prog.views[st.view] = { ts: Date.now(), err: { n: +m.n.toFixed(1), r: +m.r.toFixed(1), p: +m.p.toFixed(1) }, score: m.score, time: secs }; saveProg(); announce('view', st.view, m.score); checkComplete(); }
      f.result = f.shown ? 'View held. Not recorded because “Show me” was used; press Start again to practise it unaided.' : 'View held for ' + hold + ' s in ' + secs + ' s. Practice score ' + m.score + '.';
      renderViews(); renderNotes();
    }
    if (st.mode === 'find' && f.done) hint = '<b>' + esc(f.result) + '</b>';
    if (st.mode === 'spot') hint = st.spot && !st.spot.answered ? 'Scan the area, then name the finding below.' : hint;
    if (ui.hint.innerHTML !== hint) ui.hint.innerHTML = hint;
  }

  /* ---------------- setters */
  function setO(O) { st.O = cfg.skin.project(O).p; poseDirty = dirty2 = true; syncSliders(); }
  function setAdj(k, v) { st[k] = v; if (k === 'rot' || k === 'tilt' || k === 'rock') poseDirty = true; if (k === 'depth' || k === 'sector') dirty3 = true; dirty2 = true; syncSliders(); }
  function goPose(P) { st.O = P.O; st.rot = P.rot; st.tilt = P.tilt; st.rock = P.rock; st.O0 = basisAt(P.O); poseDirty = dirty2 = true; }
  function setProbe(key) { if (!PROBES[key]) return; st.probe = key; var p = PROBES[key]; st.depth = clamp(st.depth, p.depth[0], p.depth[1]); buildProbe(); lutKey = ''; buildSliders(); dirty2 = dirty3 = true; ui.probeSel.value = key; }
  function setView(id, opts) {
    opts = opts || {}; var vw = viewBy[id]; if (!vw) return; st.view = id;
    if (vw.probe && vw.probe !== st.probe) { st.probe = vw.probe; buildProbe(); lutKey = ''; ui.probeSel.value = st.probe; }
    var p = probe(); st.depth = clamp(vw.depth || p.defDepth || st.depth, p.depth[0], p.depth[1]); st.sector = 100;
    if (vw.params) { for (var k in vw.params) params[k] = vw.params[k]; }
    if (opts.variant !== false) { var cv2 = varBy[st.variant]; if (st.mode !== 'explore' || (cv2 && cv2.views && cv2.views.indexOf(id) < 0)) st.variant = opts.variantId || VARS[0].id; }
    rebuildS(); var T = resolveTarget(vw); target = T;
    st.colour = !!vw.colour; st.pw = !!vw.pw; if (vw.box) st.box = Object.assign({}, st.box, vw.box); if (vw.gate) st.gate = Object.assign({}, vw.gate);
    st.frozen = false; st.cal = []; st.find = { target: id, t0: performance.now(), hold: 0, done: false, shown: false };
    if (opts.scatter) {
      var b = basisAt(T.O), r = Math.random, sg = function () { return r() < 0.5 ? -1 : 1; };
      var O = add(T.O, add(mul(b.u0, sg() * (25 + 35 * r())), mul(b.N0, sg() * (20 + 30 * r()))));
      goPose({ O: basisAt(O).O, rot: wrap180(T.rot + sg() * (25 + 40 * r())), tilt: clamp(T.tilt + sg() * (8 + 14 * r()), -55, 55), rock: clamp(T.rock + sg() * (5 + 10 * r()), -40, 40) });
    } else if (opts.jitter) { goPose({ O: T.O, rot: T.rot + (Math.random() - 0.5) * opts.jitter, tilt: T.tilt + (Math.random() - 0.5) * opts.jitter, rock: T.rock + (Math.random() - 0.5) * opts.jitter * 0.6 }); }
    else goPose(T);
    buildSliders(); computePose(); buildLUT(); if (renderer) { updateScenePose(); frameCamera(true); }
    renderViews(); renderNotes(); syncToolbar(); pwBuf = []; emit('viewchange', id);
  }
  function setVariant(id) { if (!varBy[id]) return; st.variant = id; st.seed = (Math.random() * 1e9) | 0; var v = varBy[id]; if (v.views && v.views.indexOf(st.view) < 0) { setView(v.view || v.views[0], { variant: false }); return; }
    rebuildS(); if (st.mode === 'explore') { goPose(resolveTarget(viewBy[st.view])); syncSliders(); } renderNotes(); }   // anatomy may have moved: re-seat the probe on the preset
  function setMode(m) {
    st.mode = m; st.spot = null; st.reveal = true;
    Array.prototype.forEach.call(ui.modes.children, function (b) { b.setAttribute('aria-pressed', b.dataset.m === m ? 'true' : 'false'); });
    if (m === 'find') { st.variant = VARS[0].id; setView(findViews().some(function (v) { return v.id === st.view; }) ? st.view : findViews()[0].id, { scatter: true }); }
    else if (m === 'spot') newCase();
    else setView(st.view);
  }
  function newCase() {
    var pool = VARS.filter(function (v) { return v.quiz !== false; }), last = st.spot && st.spot.id, v;
    do { v = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && v.id === last);
    var answers = []; pool.forEach(function (x) { if (answers.indexOf(x.answer) < 0) answers.push(x.answer); });
    var same = [], other = []; pool.forEach(function (x) { if (x.answer === v.answer) return; ((x.group === v.group) ? same : other).push(x.answer); });
    var uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }, sh = function (a) { return a.sort(function () { return Math.random() - 0.5; }); };
    var opts = sh(uniq(same)).slice(0, 3); if (opts.length < 3) opts = opts.concat(sh(uniq(other).filter(function (x) { return opts.indexOf(x) < 0; })).slice(0, 3 - opts.length));
    opts.push(v.answer); sh(opts);
    st.spot = { id: v.id, answer: v.answer, opts: opts, answered: false, pick: null }; st.reveal = false; st.variant = v.id; st.seed = (Math.random() * 1e9) | 0;
    setView(v.view || (v.views && v.views[0]) || st.view, { variant: false, jitter: 8 });
  }
  function answerCase(a) {
    var sp = st.spot; if (!sp || sp.answered) return; sp.answered = true; sp.pick = a; st.reveal = true; var ok = a === sp.answer;
    var c = prog.cases[sp.id] || { n: 0 }; prog.cases[sp.id] = { ts: Date.now(), ok: ok || !!c.ok, n: (c.n || 0) + 1 }; saveProg(); announce('case', sp.id, ok ? 1 : 0); checkComplete();
    if (scene3 && scene3.update) scene3.update(S, true); anatUpdate(); dirty2 = dirty3 = true; renderNotes();
  }

  /* ---------------- UI */
  var ui = {}, sliders = {};
  function buildUI() {
    var wrap = el('div', { class: 'pb' + (EMBED ? ' pb-embed' : '') });
    var head = el('header', { class: 'pb-head' });
    head.innerHTML = '<div class="pb-lock">' + MARK + '<div><div class="pb-eyebrow">Kabeil Nephrology · POCUS Bench</div><h1>' + esc(cfg.title) + '</h1></div></div>';
    ui.modes = el('div', { class: 'pb-seg', role: 'group', 'aria-label': 'Mode' });
    [['explore', 'Explore'], ['find', 'Find the view'], ['spot', 'Spot the finding']].forEach(function (m) { var b = el('button', { type: 'button', 'data-m': m[0], 'aria-pressed': m[0] === 'explore' ? 'true' : 'false', id: 'pb-mode-' + m[0] }, m[1]); b.addEventListener('click', function () { setMode(m[0]); }); ui.modes.appendChild(b); });
    head.appendChild(ui.modes);
    var back = el('a', { class: 'pb-back', href: cfg.backHref || 'index.html' }, 'Back to the POCUS Bench'); back.addEventListener('click', function () { try { if (cfg.tab != null) localStorage.setItem('pb.tab', String(cfg.tab)); } catch (e) {} }); head.appendChild(back);
    wrap.appendChild(head);
    ui.views = el('nav', { class: 'pb-views', 'aria-label': 'Views' }); wrap.appendChild(ui.views);
    var grid = el('div', { class: 'pb-grid' });
    /* image pane */
    var pi = el('section', { class: 'pb-pane pb-img', 'aria-label': 'Simulated ultrasound image' });
    /* cart console: info strip / screen / touch panel / Doppler row / More drawer. Every old control id is kept (pb-freeze, pb-colour,
       pb-pw, pb-labels, pb-play, pb-clear, pb-imginfo, pb-pwwrap...) so page scripts that look them up keep working. */
    var hasFlow = !!cfg.flowAt, hasPW = hasFlow && cfg.pw !== false;
    pi.innerHTML = '<div class="pbc pbc-console" id="pb-console">' +
      '<div class="pbc-strip" aria-label="Scanner settings"><span class="pbc-probe" id="pbc-probe"></span><span class="pbc-preset" id="pbc-preset"></span><span class="pbc-d" id="pbc-d"></span><span class="pbc-g" id="pbc-g"></span><span class="pbc-mode" id="pbc-mode"></span><span class="pbc-hz" id="pbc-hz" title="Modelled frame rate: speed of sound / (2 × depth × scan lines)"></span></div>' +
      '<div class="pbc-screen pb-screen"><canvas class="pb-cv" id="pb-bm" width="' + EW + '" height="' + EH + '" role="img" aria-label="Simulated B-mode image for the current probe position"></canvas>' +
      '<div id="pb-pwwrap" hidden><canvas class="pb-strip" id="pb-strip" width="' + SW + '" height="' + SH + '" role="img" aria-label="Pulsed-wave spectral strip"></canvas><div class="pb-meas"><span id="pb-pwinfo"></span></div></div></div>' +
      '<p class="pbc-hint" id="pb-imginfo">B-mode · modelled</p>' +
      '<div class="pbc-panel pb-tb" role="toolbar" aria-label="Machine controls">' +
        '<div class="pbc-cl pbc-cl-preset"><label class="pbc-sel" id="pbc-presetkey"><small id="pbc-preset-lab">Preset</small><select id="pbc-presetsel" aria-label="Preset (view)"></select></label></div>' +
        '<div class="pbc-cl pbc-cl-core">' + '<div class="pbc-step" id="pbc-depth" role="group" aria-label="Depth"><small>Depth</small><div class="pbc-sbox"><button type="button" class="minus" aria-label="Less depth">−</button><output aria-live="off"></output><button type="button" class="plus" aria-label="More depth">+</button></div></div>' + '<div class="pbc-step" id="pbc-gain" role="group" aria-label="Gain"><small>Gain</small><div class="pbc-sbox"><button type="button" class="minus" aria-label="Less gain">−</button><output aria-live="off"></output><button type="button" class="plus" aria-label="More gain">+</button></div></div>' + '</div>' +
        '<div class="pbc-cl"><div class="pbc-modes" role="group" aria-label="Imaging mode"><button type="button" class="pbc-key" id="pb-bmode" aria-pressed="true">B</button>' + (hasFlow ? '<button type="button" class="pbc-key" id="pb-colour" aria-pressed="false" title="Colour Doppler">C</button>' : '') + (hasPW ? '<button type="button" class="pbc-key" id="pb-pw" aria-pressed="false" title="Pulsed-wave Doppler">PW</button>' : '') + '</div></div>' +
        '<div class="pbc-cl pbc-cl-frz"><button type="button" class="pbc-key frz-key" id="pb-freeze" aria-pressed="false">Freeze</button><button type="button" class="pbc-key" id="pb-calip" aria-pressed="false" title="Freeze, then tap two points on the image">Calipers</button></div>' +
        '<div class="pbc-cl pbc-cl-more"><button type="button" class="pbc-key pbc-more" id="pbc-more" aria-expanded="false" aria-controls="pbc-drawer">More ▸</button></div>' +
      '</div>' +
      '<div class="pbc-moderow" id="pbc-moderow" hidden>' + '<div class="pbc-step" id="pbc-scale" role="group" aria-label="Scale"><small>Scale</small><div class="pbc-sbox"><button type="button" class="minus" aria-label="Lower scale">−</button><output aria-live="off"></output><button type="button" class="plus" aria-label="Higher scale">+</button></div></div>' + '</div>' +
      '<div class="pbc-drawer" id="pbc-drawer" hidden>' +
        '<section class="pbc-grp" id="pbc-g-image"><h4>Image</h4><div class="pb-sliders" id="pbc-sl-image"></div></section>' +
        (hasFlow ? '<section class="pbc-grp" id="pbc-g-doppler"><h4>Doppler</h4><div class="pb-sliders" id="pbc-sl-doppler"></div></section>' : '') +
        '<section class="pbc-grp" id="pbc-g-display"><h4>Display and measure</h4><div class="pbc-keys"><button type="button" id="pb-labels" aria-pressed="true">Labels</button><button type="button" id="pb-play" aria-pressed="true">Motion</button><button type="button" id="pb-clear">Clear calipers</button></div><div id="pbc-sl-measure"></div></section>' +
        '<section class="pbc-grp" id="pbc-g-anat" hidden><h4>' + esc((cfg.anatomy && cfg.anatomy.group) || 'Anatomy model') + '</h4><div class="pb-sliders" id="pbc-sl-anat"></div><p>' + ((cfg.anatomy && cfg.anatomy.note) || 'Context only: the image is computed from the simulator’s own simplified anatomy, so the model’s ribs and organs may not line up exactly with the image.') + '</p></section>' +
      '</div></div>' +
      '<div class="pb-meas" id="pb-meas"></div>' +
      '<div class="pb-coach" aria-label="View coach"><div class="pb-bar" id="pb-bar-n"><span>Plane tilt</span><div class="trk"><i></i><b></b></div><span class="val"></span></div><div class="pb-bar" id="pb-bar-r"><span>In-plane</span><div class="trk"><i></i><b></b></div><span class="val"></span></div><div class="pb-bar" id="pb-bar-p"><span>Position</span><div class="trk"><i></i><b></b></div><span class="val"></span></div><ul class="pb-req" id="pb-req"></ul><div class="pb-hold"><i id="pb-hold"></i></div><p class="pb-hint" id="pb-hint" aria-live="polite"></p></div>';
    grid.appendChild(pi);
    /* 3D pane */
    var p3 = el('section', { class: 'pb-pane pb-3d', 'aria-label': '3D probe and scan plane' });
    p3.innerHTML = '<div class="pb-ph"><h2>Probe and plane</h2><span>drag to orbit · pinch to zoom</span></div><div class="pb-stage" id="pb-stage"><canvas class="pb-gl" id="pb-gl" aria-label="3D model with probe and scan plane. Use the sliders to move the probe with a keyboard."></canvas><canvas class="pb-giz" id="pb-giz" width="168" height="168" aria-hidden="true"></canvas><p class="pb-load" id="pb-load">Loading the 3D view…</p><div class="pb-credits" id="pb-credits" hidden role="dialog" aria-label="3D model credits"></div></div><p class="pb-nogl" id="pb-nogl" hidden>3D view is not available on this device (WebGL could not start). The image, sliders, coach and scoring all still work.</p>' +
      '<div class="pb-tb" role="toolbar" aria-label="3D tools"><button type="button" id="pb-drag" aria-pressed="false">Move probe</button><button type="button" id="pb-fan" aria-pressed="true">Plane</button><button type="button" id="pb-cut" aria-pressed="false">Cut-away</button><button type="button" id="pb-recam">Re-centre</button>' +
      (cfg.anatomy ? '<button type="button" id="pb-anat" aria-pressed="false" hidden>' + esc(cfg.anatomy.label || 'Show anatomy') + '</button><button type="button" id="pb-mcred" aria-expanded="false" aria-controls="pb-credits" hidden title="3D model credits and licences">ⓘ Models</button>' : '') +
      '<span class="pb-penchip" id="pb-penchip" hidden>Pencil ready · touch the skin to scan</span></div>';
    grid.appendChild(p3);
    /* controls */
    var pc = el('section', { class: 'pb-card pb-ctl', 'aria-label': 'Probe controls' });
    pc.innerHTML = '<h2>Probe controls</h2><div class="pb-sliders" id="pb-sliders"></div><div class="pb-padwrap"><div class="pb-pad" id="pb-pad" aria-hidden="true"><i></i></div><p>Tilt and rock pad: drag up or down to fan, left or right to rock. In the 3D pane, turn on “Move probe” to drag the probe over the skin; twist with two fingers (or scroll) to rotate.</p></div><details class="pb-pen"><summary>Apple Pencil (iPad)</summary><ul><li>Touch the skin in the 3D pane with the Pencil tip: the probe goes there and follows the tip. Fingers still orbit and pinch.</li><li>Lean the Pencil to fan (toward or away from you) and rock (left or right). Angles count from how you held it at touch-down.</li><li>Press harder to compress: veins and the IVC flatten; on cardiac and abdominal windows firmer contact also brightens the image. Lift off to release.</li><li>Pencil Pro: hover shows where the probe will land; barrel roll rotates the probe where the browser reports it. Squeeze and haptics need the native app.</li></ul></details>' +
      '<div class="pb-row"><label class="pb-field" for="pb-probe">Probe<select class="pb-sel" id="pb-probe"></select></label><button type="button" class="pb-btn" id="pb-show">Show me</button><button type="button" class="pb-btn alt" id="pb-reset">Reset probe</button></div><div id="pb-params" class="pb-sliders" style="margin-top:10px"></div>';
    grid.appendChild(pc);
    ui.notes = el('section', { class: 'pb-card pb-notes', 'aria-label': 'Teaching notes' }); grid.appendChild(ui.notes);
    wrap.appendChild(grid);
    var foot = el('footer', { class: 'pb-foot' }, '<p><b>' + DISCLAIMER + '</b></p><p>Images are parametric models, not recordings, and have not been checked against real clips. Findings are composite teaching archetypes, not patients. Scores are practice feedback only. <span class="pb-prog" id="pb-prog"></span></p>' + (cfg.footer ? '<p>' + cfg.footer + '</p>' : '') + (cfg.anatomy ? '<p class="pb-mcred" id="pb-mcredline"></p>' : ''));
    wrap.appendChild(foot); mount.appendChild(wrap);
    /* every slider becomes a console fader (bench-controls.js): dark on a scanner pane, brand on a card */
    var fade = function () { if (window.PBControls) window.PBControls.enhance(wrap, { tone: function (r) { return r.closest('.pb-pane') ? 'dark' : 'page'; } }); };
    fade(); try { new MutationObserver(function () { fade(); }).observe(wrap, { childList: true, subtree: true }); } catch (er) {}
    var $ = function (id) { return document.getElementById(id); };
    bm = $('pb-bm'); bx = bm.getContext('2d'); img = bx.createImageData(EW, EH); sc = $('pb-strip'); sx = sc.getContext('2d');
    ui.gl = $('pb-gl'); ui.giz = $('pb-giz'); ui.stage = $('pb-stage'); ui.nogl = $('pb-nogl'); ui.sl = $('pb-sliders'); ui.par = $('pb-params'); ui.probeSel = $('pb-probe');
    ui.barN = $('pb-bar-n'); ui.barR = $('pb-bar-r'); ui.barP = $('pb-bar-p'); ui.req = $('pb-req'); ui.hint = $('pb-hint'); ui.holdBar = $('pb-hold'); ui.meas = $('pb-meas'); ui.pwWrap = $('pb-pwwrap'); ui.pwInfo = $('pb-pwinfo'); ui.prog = $('pb-prog'); ui.imgInfo = $('pb-imginfo');
    ui.bFreeze = $('pb-freeze'); ui.bLabels = $('pb-labels'); ui.bPlay = $('pb-play'); ui.bDrag = $('pb-drag'); ui.bFan = $('pb-fan'); ui.bCut = $('pb-cut'); ui.bShow = $('pb-show'); ui.penChip = $('pb-penchip');
    var dummy = function () { var b = el('button', { type: 'button', hidden: '' }); b.hidden = true; return b; };    // sims without flow: detached stand-ins keep the shared code simple
    ui.bColour = $('pb-colour') || dummy(); ui.bPW = $('pb-pw') || dummy(); ui.bB = $('pb-bmode'); ui.bCal = $('pb-calip');
    ui.strip = { probe: $('pbc-probe'), preset: $('pbc-preset'), d: $('pbc-d'), g: $('pbc-g'), mode: $('pbc-mode'), hz: $('pbc-hz') };
    ui.drw = $('pbc-drawer'); ui.more = $('pbc-more'); ui.moderow = $('pbc-moderow'); ui.presetSel = $('pbc-presetsel'); ui.presetKey = $('pbc-presetkey');
    ui.slImage = $('pbc-sl-image'); ui.slDop = $('pbc-sl-doppler'); ui.slMeas = $('pbc-sl-measure'); ui.slAnat = $('pbc-sl-anat'); ui.load = $('pb-load');
    ui.bAnat = $('pb-anat'); ui.bCred = $('pb-mcred'); ui.cred = $('pb-credits');
    ui.more.addEventListener('click', function () { var open = ui.drw.hidden; ui.drw.hidden = !open; ui.more.setAttribute('aria-expanded', open ? 'true' : 'false'); ui.more.classList.toggle('open', open); ui.more.textContent = open ? 'More ▾' : 'More ▸'; });
    ui.bB.addEventListener('click', function () { if (st.colour) ui.bColour.click(); if (st.pw) ui.bPW.click(); syncToolbar(); });
    ui.bCal.addEventListener('click', function () { if (!st.frozen) ui.bFreeze.click(); else { renderMeas(); } });
    var stepper = function (id, get, nudge) { var w = $(id); if (!w) return null; var o = w.querySelector('output');
      w.querySelector('.minus').addEventListener('click', function () { nudge(-1); }); w.querySelector('.plus').addEventListener('click', function () { nudge(1); });
      return { w: w, o: o, set: function (html, lo, hi) { if (o.innerHTML !== html) o.innerHTML = html; w.querySelector('.minus').disabled = !!lo; w.querySelector('.plus').disabled = !!hi; } }; };
    /* drive the existing range input (source of truth): set .value, then fire input and change so every listener runs */
    var drive = function (inp, dir, mult) { if (!inp) return; var stp = parseFloat(inp.step) || 1, v = clamp(parseFloat(inp.value) + dir * stp * (mult || 1), parseFloat(inp.min), parseFloat(inp.max)); inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); };
    ui.stDepth = stepper('pbc-depth', null, function (d) { drive(sliders.depth && sliders.depth.inp, d); });
    ui.stGain = stepper('pbc-gain', null, function (d) { drive(sliders.gain && sliders.gain.inp, d, 2); });
    ui.stScale = stepper('pbc-scale', null, function (d) { drive(sliders.scale && sliders.scale.inp, d); });
    ui.drive = drive; ui.stepper = stepper;
    ui.slScale = el('div'); ui.slDopP = el('div'); if (ui.slDop) { ui.slDop.appendChild(ui.slScale); ui.slDop.appendChild(ui.slDopP); }
    ui.presetSel.addEventListener('change', function () { if (ui.presetSel.dataset.bind === 'param') return; var id = ui.presetSel.value; if (st.mode === 'spot') setView(id, { variant: false }); else setView(id, { scatter: st.mode === 'find' }); });
    if (ui.bAnat) ui.bAnat.addEventListener('click', function () { setAnat(!anat.on); });
    if (ui.bCred) ui.bCred.addEventListener('click', function () { var open = ui.cred.hidden; ui.cred.hidden = !open; ui.bCred.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    Object.keys(PROBES).forEach(function (k) { var o = el('option', { value: k }, esc(PROBES[k].label)); ui.probeSel.appendChild(o); });
    ui.probeSel.addEventListener('change', function () { setProbe(ui.probeSel.value); });
    var tog = function (b, key, after) { b.addEventListener('click', function () { st[key] = !st[key]; b.setAttribute('aria-pressed', st[key] ? 'true' : 'false'); dirty2 = dirty3 = true; if (after) after(); }); };
    tog(ui.bFreeze, 'frozen', function () { if (!st.frozen) st.cal = []; syncToolbar(); renderMeas(); }); tog(ui.bColour, 'colour', syncToolbar); tog(ui.bPW, 'pw', function () { pwBuf = []; sx.fillStyle = '#000'; sx.fillRect(0, 0, SW, SH); syncToolbar(); }); 
    tog(ui.bLabels, 'labels', syncToolbar); tog(ui.bPlay, 'playing', syncToolbar);
    tog(ui.bFan, 'fan', updateScenePose); tog(ui.bCut, 'cut');
    ui.bDrag.addEventListener('click', function () { st.drag = st.drag === 'probe' ? 'orbit' : 'probe'; ui.bDrag.setAttribute('aria-pressed', st.drag === 'probe' ? 'true' : 'false'); ui.gl.style.cursor = st.drag === 'probe' ? 'move' : 'grab'; });
    $('pb-recam').addEventListener('click', function () { frameCamera(true); });
    $('pb-clear').addEventListener('click', function () { st.cal = []; st.meas = []; renderMeas(); dirty2 = true; });
    ui.bShow.addEventListener('click', function () { st.find.shown = true; goPose(resolveTarget(viewBy[st.view])); var vw = viewBy[st.view]; if (vw.depth) st.depth = vw.depth; buildSliders(); computePose(); updateScenePose(); frameCamera(true); });
    $('pb-reset').addEventListener('click', function () { if (st.mode === 'find') setView(st.view, { scatter: true }); else setView(st.view, { variant: false }); });
    bm.addEventListener('click', function (e) {
      var r = bm.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * EW, py = (e.clientY - r.top) / r.height * EH, ab = img2plane(px, py), q = plane2polar(ab[0], ab[1]);
      if (st.frozen) { if (!q.ok) return; var lastc = st.cal[st.cal.length - 1]; if (lastc && !lastc.b) { lastc.b = ab; lastc.n = st.meas.length + 1; st.meas.push(Math.hypot(lastc.a[0] - ab[0], lastc.a[1] - ab[1])); renderMeas(); } else st.cal.push({ a: ab, b: null }); dirty2 = true; return; }
      if (!q.ok) return;
      if (st.pw) { st.gate.c = q.c; st.gate.r = q.r; pwBuf = []; } else if (st.colour) { st.box.c = clamp(q.c, st.box.w / 2, 1 - st.box.w / 2); st.box.r = clamp(q.r, st.box.h / 2, 1 - st.box.h / 2); }
      dirty2 = true;
    });
    var pad = $('pb-pad'), knob = pad.firstChild, padOn = false, padMove = function (e) { var r = pad.getBoundingClientRect(), fx = clamp((e.clientX - r.left) / r.width, 0, 1), fy = clamp((e.clientY - r.top) / r.height, 0, 1); st.rock = Math.round((fx - 0.5) * 90); st.tilt = Math.round((0.5 - fy) * 120); poseDirty = dirty2 = true; syncSliders(); };
    pad.addEventListener('pointerdown', function (e) { padOn = true; try { pad.setPointerCapture(e.pointerId); } catch (er) {} padMove(e); }); pad.addEventListener('pointermove', function (e) { if (padOn) padMove(e); });
    pad.addEventListener('pointerup', function () { padOn = false; }); pad.addEventListener('pointercancel', function () { padOn = false; }); ui.knob = knob;
  }
  function slider(host, id, label, min, max, step, get, set, fmt) {
    var w = el('div', { class: 'pb-sl' }), o = el('output', { for: 'pb-s-' + id }), inp = el('input', { type: 'range', id: 'pb-s-' + id, min: min, max: max, step: step });
    w.appendChild(el('label', { for: 'pb-s-' + id }, esc(label))); w.appendChild(o); w.appendChild(inp); host.appendChild(w);
    var s = { inp: inp, sync: function () { var v = get(); inp.value = v; o.textContent = fmt(v); } };
    inp.addEventListener('input', function () { set(parseFloat(inp.value)); o.textContent = fmt(parseFloat(inp.value)); syncConsole(); });
    s.sync(); return s;
  }
  function buildSliders() {
    ui.sl.innerHTML = ''; ui.slImage.innerHTML = ''; ui.slScale.innerHTML = ''; sliders = {}; var p = probe(), sl = cfg.slideLabels || ['Slide along the body (head / feet)', 'Slide around the body'];
    var deg = function (v) { return (v > 0 ? '+' : '') + Math.round(v) + '°'; }, mm = function (v) { return (v > 0 ? '+' : '') + Math.round(v) + ' mm'; };
    var slideSet = function (ia) { return function (v) { var b = st.O0, cur = sub(st.O, b.O), a = ia ? dot(cur, b.u0) : v, c = ia ? v : dot(cur, b.N0); st.O = cfg.skin.project(add(b.O, add(mul(b.u0, a), mul(b.N0, c)))).p; poseDirty = dirty2 = true; }; };
    sliders.sa = slider(ui.sl, 'sa', sl[0], -120, 120, 1, function () { return clamp(dot(sub(st.O, st.O0.O), st.O0.u0), -120, 120); }, slideSet(0), mm);
    sliders.sb = slider(ui.sl, 'sb', sl[1], -120, 120, 1, function () { return clamp(dot(sub(st.O, st.O0.O), st.O0.N0), -120, 120); }, slideSet(1), mm);
    sliders.rot = slider(ui.sl, 'rot', 'Rotate (index marker)', -180, 180, 1, function () { return wrap180(st.rot); }, function (v) { st.rot = v; poseDirty = dirty2 = true; }, deg);
    sliders.tilt = slider(ui.sl, 'tilt', 'Tilt / fan', -60, 60, 1, function () { return st.tilt; }, function (v) { st.tilt = v; poseDirty = dirty2 = true; syncPad(); }, deg);
    sliders.rock = slider(ui.sl, 'rock', 'Rock (heel–toe)', -45, 45, 1, function () { return st.rock; }, function (v) { st.rock = v; poseDirty = dirty2 = true; syncPad(); }, deg);
    sliders.depth = slider(ui.slImage, 'depth', 'Depth', p.depth[0], p.depth[1], 1, function () { return st.depth; }, function (v) { st.depth = v; dirty2 = true; if (pose) { buildLUT(); updateScenePose(); } }, function (v) { return v + ' cm'; });
    sliders.gain = slider(ui.slImage, 'gain', 'Gain', 0.4, 2.2, 0.05, function () { return st.gain; }, function (v) { st.gain = v; dirty2 = true; }, function (v) { return v.toFixed(2); });
    sliders.tgc = slider(ui.slImage, 'tgc', 'Far-field gain (TGC)', -1, 1, 0.05, function () { return st.tgc; }, function (v) { st.tgc = v; dirty2 = true; }, function (v) { return (v > 0 ? '+' : '') + v.toFixed(2); });
    if (p.type !== 'linear') sliders.sector = slider(ui.slImage, 'sector', 'Sector width', 40, 100, 5, function () { return st.sector; }, function (v) { st.sector = v; dirty2 = true; if (pose) { buildLUT(); updateScenePose(); } }, function (v) { return v + '%'; });
    if (cfg.flowAt) sliders.scale = slider(ui.slScale, 'scale', 'Doppler scale', 5, 120, 5, function () { return st.scale; }, function (v) { st.scale = v; dirty2 = true; }, function (v) { return '±' + v + ' cm/s'; });
    syncPad(); syncConsole();
  }
  function syncPad() { if (ui.knob) { ui.knob.style.left = clamp(50 + st.rock / 90 * 100, 0, 100) + '%'; ui.knob.style.top = clamp(50 - st.tilt / 120 * 100, 0, 100) + '%'; } }
  function syncSliders() { for (var k in sliders) sliders[k].sync(); syncPad(); syncConsole(); }
  var psl;                              // param sliders by id (no initialiser: buildParams may run before this line)
  /* Machine settings among the sim's params move to the console (UI placement only; ids, values and handlers are unchanged):
     'moderow' = Doppler row under the panel (numeric: −/+ stepper driving the slider kept in the drawer; select/toggle: the select itself),
     'doppler' / 'measure' = drawer groups, 'preset' = the Preset key. Everything else (patient and scenario settings) stays on the probe card.
     A param can set p.ui itself; these ids are the defaults. */
  var MACH = { steer: 'moderow', gate: 'moderow', base: 'moderow', sv: 'moderow', wf: 'doppler', inv: 'doppler', mean: 'doppler', mmtrap: 'measure', preset: 'preset' };
  function buildParams() {
    ui.par.innerHTML = ''; psl = {}; ui.slDopP.innerHTML = ''; ui.slMeas.innerHTML = '';
    Array.prototype.forEach.call(ui.moderow.querySelectorAll('.pbc-mp'), function (n) { n.remove(); });
    var presetBound = false;
    (cfg.params || []).forEach(function (p) {
      var cur = function () { return params[p.id] != null ? params[p.id] : p.value; }, where = p.ui || MACH[p.id] || 'card';
      if (where === 'moderow' && !cfg.flowAt) where = 'card';
      var host = where === 'doppler' || where === 'moderow' ? ui.slDopP : where === 'measure' ? ui.slMeas : ui.par;
      if (p.type === 'select' || p.type === 'toggle') {
        var opts = p.type === 'toggle' ? [[false, p.off || 'Off'], [true, p.on || 'On']] : p.options, f = el('label', { class: 'pb-field', for: 'pb-p-' + p.id }, esc(p.label)), s = el('select', { class: 'pb-sel', id: 'pb-p-' + p.id });
        opts.forEach(function (o, i) { var op = el('option', { value: i }, esc(o[1])); if (o[0] === cur()) op.selected = true; s.appendChild(op); });
        s.addEventListener('change', function () { params[p.id] = opts[+s.value][0]; rebuildS(); renderNotes(); syncConsole(); });
        if (where === 'preset' && !presetBound) {           // the sim's own preset selector becomes the Preset key
          presetBound = true; ui.presetSel.dataset.bind = 'param'; ui.presetSel.innerHTML = ''; ui.presetSel.id = 'pbc-presetsel'; ui.presetSel.style.display = 'none';
          Array.prototype.forEach.call(ui.presetKey.querySelectorAll('select.pb-sel'), function (n) { n.remove(); });
          s.className = 'pbc-psel'; s.setAttribute('aria-label', p.label); ui.presetKey.appendChild(s); ui.presetKey.title = p.label; return;
        }
        if (where === 'moderow') { var lab = el('label', { class: 'pbc-sel pbc-mp', for: 'pb-p-' + p.id }, '<small>' + esc(p.short || p.label) + '</small>'); s.className = ''; lab.appendChild(s); ui.moderow.appendChild(lab); return; }
        f.appendChild(s); host.appendChild(f);
      } else {
        psl[p.id] = slider(host, 'p-' + p.id, p.label, p.min, p.max, p.step, cur, function (v) { params[p.id] = v; rebuildS(); syncConsole(); }, p.fmt || function (v) { return String(v); });
        if (where === 'moderow') {
          var w = el('div', { class: 'pbc-step pbc-mp', role: 'group', 'aria-label': p.label }); w.innerHTML = '<small>' + esc(p.short || p.label.replace(/^PW /, '').replace(/ (size|shift)$/, '')) + '</small><div class="pbc-sbox"><button type="button" class="minus" aria-label="Decrease ' + esc(p.label) + '">−</button><output aria-live="off"></output><button type="button" class="plus" aria-label="Increase ' + esc(p.label) + '">+</button></div>';
          var inp = psl[p.id].inp, short = p.short || p.label.replace(/^PW /, '').replace(/ (size|shift)$/, '');
          w.querySelector('.minus').addEventListener('click', function () { ui.drive(inp, -1); }); w.querySelector('.plus').addEventListener('click', function () { ui.drive(inp, 1); });
          var o = w.querySelector('output'), upd = function () { var v = parseFloat(inp.value); o.textContent = (p.fmt || String)(v); w.querySelector('.minus').disabled = v <= parseFloat(inp.min); w.querySelector('.plus').disabled = v >= parseFloat(inp.max); };
          inp.addEventListener('input', upd); inp.addEventListener('change', upd); upd(); var sy = psl[p.id].sync; psl[p.id].sync = function () { sy(); upd(); };
          ui.moderow.appendChild(w);
        }
      }
    });
    if (!presetBound) { ui.presetSel.dataset.bind = 'view'; ui.presetSel.style.display = ''; }
    if (ui.slMeas && !ui.slMeas.children.length) ui.slMeas.hidden = true; else if (ui.slMeas) ui.slMeas.hidden = false;
    var dg = document.getElementById('pbc-g-doppler'); if (dg) dg.hidden = false;
  }
  function syncToolbar() {
    [[ui.bFreeze, 'frozen'], [ui.bColour, 'colour'], [ui.bPW, 'pw'], [ui.bLabels, 'labels'], [ui.bPlay, 'playing'], [ui.bFan, 'fan'], [ui.bCut, 'cut']].forEach(function (x) { x[0].setAttribute('aria-pressed', st[x[1]] ? 'true' : 'false'); });
    ui.bFreeze.classList.toggle('frz', !!st.frozen); ui.bFreeze.setAttribute('aria-pressed', 'false'); ui.bFreeze.textContent = st.frozen ? 'Frozen' : 'Freeze';   // amber when frozen (not the mode colour)
    ui.bColour.classList.toggle('on', !!st.colour); ui.bPW.classList.toggle('on', !!st.pw);
    ui.bB.setAttribute('aria-pressed', !st.colour && !st.pw ? 'true' : 'false'); ui.bB.classList.toggle('on', !st.colour && !st.pw);
    ui.bCal.setAttribute('aria-pressed', st.frozen ? 'true' : 'false'); ui.bCal.classList.toggle('on', !!st.frozen);
    ui.moderow.hidden = !(cfg.flowAt && (st.colour || st.pw));
    ui.pwWrap.hidden = !(st.pw && cfg.flowAt);
    ui.imgInfo.textContent = (st.colour ? 'Colour Doppler · tap to move the box' : st.pw ? 'PW · tap to place the gate' : st.frozen ? 'Frozen · tap twice to measure' : 'B-mode · modelled');
    syncConsole();
  }
  /* info strip, steppers and Preset key: read from state, written only when the text changes */
  var GAIN_MID = 1;
  function gainNum(g) { return Math.round(g <= GAIN_MID ? (g - 0.4) / (GAIN_MID - 0.4) * 50 : 50 + (g - GAIN_MID) / (2.2 - GAIN_MID) * 50); }   // console reading 0..100 (50 = default gain 1.00)
  function frameRate() {                   // modelled: c / (2 · depth · lines); colour divides by the packet over the box width; shown as an indication only
    var p = probe(), lines = p.type === 'linear' ? 128 : Math.round(128 * st.sector / 100), fr = 154000 / (2 * st.depth * lines);
    if (st.colour) fr = fr / (1 + 7 * st.box.w); return Math.max(1, Math.min(60, Math.round(fr)));
  }
  function shortProbe(lbl) { return String(lbl).replace(/\s*\(.*\)\s*/, '').replace(/ about /, ' '); }
  function syncConsole() {
    if (!ui.strip || !st.probe) return; var p = probe(), vw = viewBy[st.view] || {}, set = function (n, t) { if (n && n.textContent !== t) n.textContent = t; };
    var pk = ui.presetKey.querySelector('select.pbc-psel'), presetTxt = pk ? pk.options[pk.selectedIndex].textContent : (vw.group ? vw.group + ' · ' : '') + (vw.short || vw.name || '');
    set(ui.strip.probe, shortProbe(p.label)); set(ui.strip.preset, presetTxt); set(ui.strip.d, 'D ' + st.depth + ' cm'); set(ui.strip.g, 'G ' + gainNum(st.gain));
    set(ui.strip.mode, (st.frozen ? 'FROZEN · ' : '') + (st.colour && st.pw ? 'C + PW' : st.colour ? 'B + C' : st.pw ? 'PW' : 'B')); ui.strip.mode.classList.toggle('frz', !!st.frozen); set(ui.strip.hz, frameRate() + ' Hz');
    ui.stDepth.set(st.depth + ' cm', st.depth <= p.depth[0], st.depth >= p.depth[1]);
    ui.stGain.set(String(gainNum(st.gain)), st.gain <= 0.4 + 1e-6, st.gain >= 2.2 - 1e-6);
    if (cfg.flowAt) ui.stScale.set('±' + st.scale + ' cm/s', st.scale <= 5, st.scale >= 120);
    if (ui.presetSel.dataset.bind !== 'param') {
      if (ui.presetSel.dataset.built !== '1') {
        var groups = [], h = ''; VIEWS.forEach(function (v) { if (groups.indexOf(v.group || '') < 0) groups.push(v.group || ''); });
        groups.forEach(function (g) { h += g ? '<optgroup label="' + esc(g) + '">' : ''; VIEWS.forEach(function (v) { if ((v.group || '') === g) h += '<option value="' + esc(v.id) + '">' + esc(v.short || v.name) + '</option>'; }); h += g ? '</optgroup>' : ''; });
        ui.presetSel.innerHTML = h; ui.presetSel.dataset.built = '1';
      }
      if (ui.presetSel.value !== st.view) ui.presetSel.value = st.view;
    }
  }
  function renderMeas() {
    var h = st.meas.map(function (d, i) { return '<span>D' + (i + 1) + ' <b>' + (d / 10).toFixed(1) + ' cm</b></span>'; }).join('');
    (cfg.calcs || []).forEach(function (c) { if (st.meas.length >= c.needs) { var v = c.compute(st.meas.map(function (d) { return d / 10; })); h += '<span>' + esc(c.label) + ' <b>' + v + '</b></span>'; } });
    if (!h && st.frozen) h = '<span>Tap two points on the frozen image to measure. Measurements stay listed after you unfreeze.</span>';
    ui.meas.innerHTML = h;
  }
  function renderViews() {
    ui.views.innerHTML = '';
    VIEWS.forEach(function (v) {
      var b = el('button', { type: 'button', class: 'pb-chip' + (prog.views[v.id] ? ' done' : ''), 'aria-pressed': v.id === st.view ? 'true' : 'false', id: 'pb-v-' + v.id }, '<small>' + esc(v.group || '') + '</small><b>' + esc(v.short || v.name) + '</b>');
      b.addEventListener('click', function () { if (st.mode === 'spot') setView(v.id, { variant: false }); else setView(v.id, { scatter: st.mode === 'find' }); });
      ui.views.appendChild(b);
    });
    var nv = findViews().filter(function (v) { return prog.views[v.id]; }).length, nc = 0; for (var k in prog.cases) if (prog.cases[k].ok) nc++;
    ui.prog.textContent = 'Practice record on this device: views ' + nv + '/' + findViews().length + ', findings named ' + nc + '.';
  }
  function list(a) { return a && a.length ? '<ul>' + a.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : ''; }
  function viewNotes(v) {
    return '<span class="pb-tag">' + esc(v.group || 'View') + '</span><h2>' + esc(v.name) + '</h2>' + (v.how ? '<p>' + v.how + '</p>' : '') + (v.see ? '<h3>What the image should show</h3>' + list(v.see) : '') + (v.tip ? '<div class="pb-call"><p>' + v.tip + '</p></div>' : '');
  }
  function renderNotes() {
    var v = viewBy[st.view], va = varBy[st.variant], h = '', n = ui.notes;
    if (st.mode === 'explore') {
      h = viewNotes(v) + '<h3>Finding shown</h3><label class="pb-field" for="pb-variant"><span class="pb-muted" style="font-weight:400">Composite teaching archetypes, not patients.</span><select class="pb-sel" id="pb-variant">';
      var groups = []; VARS.forEach(function (x) { if (groups.indexOf(x.group || '') < 0) groups.push(x.group || ''); });
      groups.forEach(function (g) { h += (g ? '<optgroup label="' + esc(g) + '">' : ''); VARS.forEach(function (x) { if ((x.group || '') === g) h += '<option value="' + x.id + '"' + (x.id === st.variant ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }); h += (g ? '</optgroup>' : ''); });
      h += '</select></label>' + (va && va.teach ? '<div class="pb-call"><div>' + va.teach + '</div></div>' : '') + (cfg.notes || '');
      n.innerHTML = h; n.querySelector('#pb-variant').addEventListener('change', function (e) { setVariant(e.target.value); });
    } else if (st.mode === 'find') {
      h = '<span class="pb-tag">Find the view</span><h2>' + esc(v.name) + '</h2><p>The probe starts off target. Move it until all three bars are inside the tolerance mark and every check is filled, then hold for ' + (v.hold || cfg.hold || 1.5) + ' s. The coach under the image says what to change next.</p>' + (v.how ? '<p>' + v.how + '</p>' : '') + '<ul class="pb-check">';
      findViews().forEach(function (x) { var p = prog.views[x.id]; h += '<li><button type="button" data-v="' + x.id + '" aria-pressed="' + (x.id === st.view) + '"><span>' + esc(x.name) + '</span><span class="s">' + (p ? 'held · score ' + p.score + ' · ' + p.time + ' s' : 'not yet') + '</span></button></li>'; });
      h += '</ul><div class="pb-row"><button type="button" class="pb-btn" id="pb-start">Start again from a new position</button></div><p class="pb-muted">Tolerance: plane within ' + ((v.tol && v.tol.normal) || 10) + '°, in-plane rotation within ' + ((v.tol && v.tol.rot) || 15) + '°, position within ' + ((v.tol && v.tol.slide) || 10) + ' mm. Practice feedback only.</p>';
      n.innerHTML = h; Array.prototype.forEach.call(n.querySelectorAll('[data-v]'), function (b) { b.addEventListener('click', function () { setView(b.dataset.v, { scatter: true }); }); });
      n.querySelector('#pb-start').addEventListener('click', function () { setView(st.view, { scatter: true }); });
    } else {
      var sp = st.spot || {};
      h = '<span class="pb-tag">Spot the finding</span><h2>Name what the image shows</h2><p>A composite teaching archetype is loaded. Scan through it (fan, rotate, change view, use colour where it helps), then choose.</p><div class="pb-opts">';
      (sp.opts || []).forEach(function (o, i) { var cls = sp.answered ? (o === sp.answer ? 'right' : (o === sp.pick ? 'wrong' : '')) : ''; h += '<button type="button" data-o="' + i + '" class="' + cls + '"' + (sp.answered ? ' disabled' : '') + '>' + esc(o) + (sp.answered && o === sp.answer ? ' — shown' : '') + '</button>'; });
      h += '</div>';
      if (sp.answered) h += '<div class="pb-call"><div><b>' + (sp.pick === sp.answer ? 'Yes.' : 'Not this one.') + '</b> ' + (va.teach || '') + '</div></div><div class="pb-row"><button type="button" class="pb-btn" id="pb-next">Next case</button></div>';
      n.innerHTML = h; Array.prototype.forEach.call(n.querySelectorAll('[data-o]'), function (b) { b.addEventListener('click', function () { answerCase(sp.opts[+b.dataset.o]); }); });
      var nx = n.querySelector('#pb-next'); if (nx) nx.addEventListener('click', newCase);
    }
    sectionize(n);
    ui.bShow.disabled = false;
    renderViews();
  }
  /* Collapsible notes (Ahmed, 2026-10-06: "make the stack of information like a collapsible list"). Every <h3> in the notes panel and
     everything after it up to the next heading becomes one <details>; the open/closed choice is kept per heading for the session, so
     changing view or finding does not reset it. Moving nodes keeps their listeners, so this runs after the handlers are attached. */
  var secOpen = {}, SEC_DEFAULT = { 'What the image should show': true, 'Finding shown': true };
  function sectionize(n) {
    var kids = Array.prototype.slice.call(n.childNodes), cur = null;
    kids.forEach(function (k) {
      if (k.nodeType === 1 && (k.tagName === 'H2' || k.tagName === 'SPAN' && k.classList.contains('pb-tag'))) { cur = null; return; }
      if (k.nodeType === 1 && k.tagName === 'H3') {
        var key = k.textContent.trim(), d = document.createElement('details'), sm = document.createElement('summary');
        d.className = 'pb-sec'; d.open = key in secOpen ? secOpen[key] : !!SEC_DEFAULT[key];
        d.addEventListener('toggle', function () { secOpen[key] = d.open; });
        n.insertBefore(d, k); sm.appendChild(k); d.appendChild(sm); cur = d; return;
      }
      if (cur) cur.appendChild(k);
    });
  }

  /* ---------------- main loop */
  var last = 0, acc = 0, nfr = -12, downs = 0, coachT = 0;   // nfr starts negative: the first frames (JIT warm-up) are not timed
  function animating() { if (st.frozen || !st.playing) return false; if (cfg.animate === 'always') return true; if (typeof cfg.animate === 'function') return !!cfg.animate(st, S); return (st.colour || st.pw) && !!cfg.flowAt; }
  function tick(ts) {
    requestAnimationFrame(tick);
    if (document.hidden) { last = ts; return; }
    var dt = (ts - last) / 1000; if (dt < 0.031) return; last = ts; if (dt > 0.2) dt = 0.2;
    step(dt);
  }
  function step(dt) {                     // one simulation + render step; also exposed as api.step for tests
    var anim = animating(); if (anim) { st.t += dt; dirty2 = true; }
    var moved = poseDirty;
    if (poseDirty) { computePose(); buildLUT(); updateScenePose(); }
    if (dirty2) {
      var t0 = performance.now(); renderB(); dirty2 = false; var ms = performance.now() - t0;
      if (st.pw && cfg.flowAt && anim) drawPW(dt);
      nfr++; if (nfr > 0) acc += ms;
      if (nfr >= 12) { var avg = acc / nfr; acc = 0; nfr = 0; if (avg > 24 && qi > 0) { qi--; downs++; allocQ(); dirty2 = true; } else if (avg < 7 && qi < QUAL.length - 1 && downs < 2) { qi++; allocQ(); dirty2 = true; } }
      coachT = 1;
    }
    coachT += dt; if (moved || coachT > 0.12) { updateCoach(Math.min(coachT, 0.25)); coachT = 0; }
    render3D();
  }

  /* ---------------- public api + boot */
  var api = {
    cfg: cfg, st: st, get S() { return S; }, get pose() { return pose; }, get target() { return target; }, get metrics() { return metrics; }, get quality() { return [NL, NS]; }, get pwStats() { return pwStats; },
    setView: setView, setVariant: setVariant, setMode: setMode, setProbe: setProbe, setParam: function (k, v) { params[k] = v; rebuildS(); buildParams(); }, setPose: function (p) { goPose(p.n ? paramsFrom(p.O, p.n, p.u) : p); syncSliders(); },
    redraw: function () { dirty2 = dirty3 = true; }, poseFrom: poseFrom, paramsFrom: paramsFrom, basisAt: basisAt, world2img: function (p) { return world2img(p); }, progress: function () { return prog; },
    step: step, on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }, sampleIds: function () { return ids; }, hist: hist,
    evalView: function () { if (poseDirty) computePose(); return evalView(); }, get cam() { return cam; }, syncToolbar: function () { syncToolbar(); }, redraw3d: function () { dirty3 = true; render3D(); }, get anatomy() { return anat; }, setAnatomy: function (on) { setAnat(on); }, setAnatomyOpacity: setAnatOpacity
  };
  st.probe = VIEWS[0].probe || Object.keys(PROBES)[0];
  buildUI(); allocQ();
  buildParams(); setView(st.view); syncToolbar(); renderMeas();
  if (REDUCED) { st.playing = false; syncToolbar(); }
  requestAnimationFrame(tick);
  /* 3D pane: starts when three.js has loaded; the image, coach and scoring never wait for it */
  var no3D = function () { renderer = null; ui.stage.hidden = true; ui.nogl.hidden = false; if (ui.load) ui.load.hidden = true; ui.bDrag.disabled = ui.bFan.disabled = ui.bCut.disabled = true; document.getElementById('pb-recam').disabled = true; };
  api.ready3d = NOGL ? (no3D(), Promise.resolve(false)) : loadThree().then(function (T) {
    if (!T) { no3D(); return false; }
    T3 = T; var ok3 = false; try { ok3 = init3D(); } catch (e) { ok3 = false; if (window.console) console.warn('PBSim: 3D pane disabled', e); }
    if (!ok3) { no3D(); return false; }
    if (ui.load) ui.load.hidden = true;
    try { if (scene3 && scene3.update) scene3.update(S, st.reveal); } catch (e) { if (window.console) console.warn(e); }
    computePose(); buildLUT(); updateScenePose(); frameCamera(false); dirty3 = true;
    loadAnatomy(); emit('ready3d', api); return true;
  });
  return api;
}

window.PBSim = { version: '1.1.0', loadThree: loadThree, create: create, V: V, geo: { cylinder: cylinder, plane: plane, frame: frame }, wave: wave, hash3: hash3, tissueIds: tissueIds, DISCLAIMER: DISCLAIMER };
})();
