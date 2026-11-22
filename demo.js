/* サンプル表示用の合成データ（実在の選手の動画ではありません）
 * 20spm前後・約18秒。ストロークごとに少しずつ姿勢を変え、ばらつきと注意表示が見えるようにしている */
(function (root) {
  'use strict';
  function ease(u, a, b) { if (u <= a) return 0; if (u >= b) return 1; var x = (u - a) / (b - a); return x * x * (3 - 2 * x); }
  function rnd(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

  function makeDemo() {
    var W = 1280, H = 720, fps = 30, rand = rnd(7);
    var SIDE = root.ErgAnalysis.SIDE;
    var plan = [
      { T: 3.0, kC: 54, tC: 24, tF: -21 }, { T: 2.95, kC: 52, tC: 27, tF: -23 }, { T: 3.05, kC: 47, tC: 25, tF: -20 },
      { T: 2.9, kC: 40, tC: 31, tF: -33 }, { T: 3.0, kC: 53, tC: 23, tF: -19 }, { T: 3.0, kC: 51, tC: 26, tF: -22 },
      { T: 2.95, kC: 55, tC: 22, tF: -18 }
    ];
    var bR = [0.07, 0.075, 0.08, 0.12, 0.10, 0.105, 0.11]; // 背中の丸み（後半ほど丸くなる設定）
    var l = 0.45, trunkLen = 0.55, upper = 0.3, fore = 0.28, scale = 330, ox = 600, oy = 470, dir = 1;
    var frames = [], t0 = 0, si = 0, tt = 0, total = plan.reduce(function (s, p) { return s + p.T; }, 0);
    for (var i = 0; i < Math.floor(total * fps); i++) {
      tt = i / fps;
      while (si < plan.length - 1 && tt >= t0 + plan[si].T) { t0 += plan[si].T; si++; }
      var p = plan[si], q = plan[Math.min(si + 1, plan.length - 1)];
      var ph = (tt - t0) / p.T, df = 0.36, legs, body, arms, kC = p.kC, tC = p.tC;
      if (ph < df) { var u = ph / df; legs = ease(u, 0, 0.6); body = ease(u, 0.3 + (p.kC < 45 ? -0.12 : 0), 0.9); arms = ease(u, 0.62, 1); }
      else { var v = (ph - df) / (1 - df); arms = 1 - ease(v, 0, 0.2); body = 1 - ease(v, 0.2, 0.48); legs = 1 - ease(v, 0.42, 1); kC = p.kC + (q.kC - p.kC) * ease(v, 0.4, 1); tC = p.tC + (q.tC - p.tC) * ease(v, 0.2, 0.48); }
      var knee = kC + (174 - kC) * legs, trunk = tC + (p.tF - tC) * body, elbow = 170 + (72 - 170) * arms;
      var drop = 0.12, d = 2 * l * Math.sin(knee * Math.PI / 360), hz = Math.sqrt(Math.max(d * d - drop * drop, 0));
      var an = { f: 0, u: 0 }, hip = { f: -hz, u: drop };
      var mx = (an.f + hip.f) / 2, my = (an.u + hip.u) / 2, h = Math.sqrt(Math.max(l * l - d * d / 4, 0));
      var ux = (an.f - hip.f) / d, uy = (an.u - hip.u) / d, nx = -uy, ny = ux; if (ny < 0) { nx = -nx; ny = -ny; }
      var kn = { f: mx + nx * h, u: my + ny * h }, tr = trunk * Math.PI / 180;
      var sh = { f: hip.f + trunkLen * Math.sin(tr), u: hip.u + trunkLen * Math.cos(tr) };
      // 腕：ハンドルは一定の高さを水平に動く。肩〜手首の距離を肘角度から求め、肘は線の下側に置く
      var hu = hip.u + 0.33, D = Math.sqrt(upper * upper + fore * fore - 2 * upper * fore * Math.cos(elbow * Math.PI / 180));
      var dv = sh.u - hu, dh = Math.sqrt(Math.max(D * D - dv * dv, 0.0001));
      var wr = { f: sh.f + dh, u: hu }, Dr = Math.hypot(wr.f - sh.f, wr.u - sh.u);
      var a1 = (upper * upper - fore * fore + Dr * Dr) / (2 * Dr), hh = Math.sqrt(Math.max(upper * upper - a1 * a1, 0));
      var ex = (wr.f - sh.f) / Dr, ey = (wr.u - sh.u) / Dr, bx = sh.f + ex * a1, by = sh.u + ey * a1;
      var n1 = { f: bx - ey * hh, u: by + ex * hh }, n2 = { f: bx + ey * hh, u: by - ex * hh };
      var el = n1.u < n2.u ? n1 : n2;
      var ear = { f: sh.f + 0.2 * Math.sin(tr), u: sh.u + 0.2 * Math.cos(tr) };
      var P = { ear: ear, sh: sh, el: el, wr: wr, hip: hip, kn: kn, an: an };
      var lm = []; for (var k = 0; k < 33; k++) lm.push({ x: 0.5, y: 0.5, visibility: 0.05 });
      Object.keys(P).forEach(function (key) {
        var pt = P[key];
        var px = function (off, vis) { return { x: (ox + dir * pt.f * scale + off + (rand() - 0.5) * 3) / W, y: (oy - pt.u * scale + (rand() - 0.5) * 3) / H, visibility: vis }; };
        lm[SIDE.L[key]] = px(0, 0.95); lm[SIDE.R[key]] = px(-8, 0.55);
      });
      lm[0] = { x: lm[7].x + 0.012, y: lm[7].y + 0.01, visibility: 0.9 };
      // 背中の輪郭（合成）：腰→肩の軸から背中側までの距離。キャッチに近いほど丸みを大きくする
      var hx = (lm[23].x + lm[24].x) / 2 * W, hy = (lm[23].y + lm[24].y) / 2 * H, sx = (lm[11].x + lm[12].x) / 2 * W, sy = (lm[11].y + lm[12].y) / 2 * H;
      var Lp = Math.hypot(sx - hx, sy - hy), b = bR[si] * (1 - 0.6 * body), dp = [], dm = [];
      for (var kk = 0; kk < 41; kk++) {
        var uu = kk / 40;
        dp.push(Math.round((Lp * (0.17 - 0.07 * uu) + b * Lp * Math.sin(Math.PI * Math.min(1, uu / 0.95)) + (rand() - 0.5) * 1.5) * 10) / 10);
        dm.push(Math.round(Lp * (0.12 - 0.02 * uu) * 10) / 10);
      }
      frames.push({ t: Math.round(tt * 1000) / 1000, lm: lm, back: { hx: hx, hy: hy, sx: sx, sy: sy, dp: dp, dm: dm } });
    }
    return { frames: frames, W: W, H: H, fps: fps, erg: { railY: (oy - 0.12 * scale + 22) / H, footX: ox / W, dir: dir } };
  }
  root.ErgDemo = { make: makeDemo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
