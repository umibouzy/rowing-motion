/* エルゴ骨格解析ロジック（ブラウザ・Node 共通）
 * 入力: frames = [{t: 秒, lm: [{x,y,visibility}] x33 | null}], 動画の幅W・高さH
 * 座標は MediaPipe の正規化座標（0-1）を画素に直してから計算する（縦横比の歪みを防ぐため）
 */
(function (root) {
  'use strict';

  var SIDE = {
    L: { ear: 7, sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27 },
    R: { ear: 8, sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28 }
  };
  var KEYS = ['ear', 'sh', 'el', 'wr', 'hip', 'kn', 'an'];
  var VIS_MIN = 0.15;

  function vis(p) { return p && typeof p.visibility === 'number' ? p.visibility : 1; }

  function angle3(ax, ay, bx, by, cx, cy) {
    var v1x = ax - bx, v1y = ay - by, v2x = cx - bx, v2y = cy - by;
    var d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!d || !isFinite(d)) return NaN;
    var c = (v1x * v2x + v1y * v2y) / d;
    c = Math.max(-1, Math.min(1, c));
    return Math.acos(c) * 180 / Math.PI;
  }

  function percentile(arr, p) {
    var a = arr.filter(isFinite).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }
  function median(arr) { return percentile(arr, 0.5); }
  function mean(arr) { var a = arr.filter(isFinite); return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : NaN; }
  function sd(arr) {
    var a = arr.filter(isFinite); if (a.length < 2) return NaN;
    var m = mean(a); return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // 手前側（カメラに近い側）を可視度の合計で判定
  function chooseSide(frames) {
    var sL = 0, sR = 0;
    frames.forEach(function (f) {
      if (!f.lm) return;
      ['sh', 'el', 'wr', 'hip', 'kn', 'an'].forEach(function (k) {
        sL += vis(f.lm[SIDE.L[k]]); sR += vis(f.lm[SIDE.R[k]]);
      });
    });
    return sL >= sR ? 'L' : 'R';
  }

  // 関節ごとの時系列（画素座標）を作る。mode: 'near'（手前側）| 'avg'（左右平均）
  function buildTracks(frames, W, H, mode, side) {
    var n = frames.length, J = {};
    KEYS.forEach(function (k) { J[k] = { x: new Array(n).fill(NaN), y: new Array(n).fill(NaN) }; });
    for (var i = 0; i < n; i++) {
      var lm = frames[i].lm; if (!lm) continue;
      KEYS.forEach(function (k) {
        var pL = lm[SIDE.L[k]], pR = lm[SIDE.R[k]], x = NaN, y = NaN;
        if (mode === 'avg') {
          var vl = vis(pL), vr = vis(pR);
          if (pL && pR && vl >= 0.3 && vr >= 0.3) { x = (pL.x + pR.x) / 2; y = (pL.y + pR.y) / 2; }
          else { var p = vl >= vr ? pL : pR; if (p && vis(p) >= VIS_MIN) { x = p.x; y = p.y; } }
        } else {
          var q = lm[SIDE[side][k]];
          if (q && vis(q) >= VIS_MIN) { x = q.x; y = q.y; }
        }
        J[k].x[i] = x * W; J[k].y[i] = y * H;
      });
    }
    return J;
  }

  // 短い欠損を線形補間
  function fillGaps(a, maxGap) {
    var n = a.length, out = a.slice(), i = 0;
    while (i < n) {
      if (isFinite(out[i])) { i++; continue; }
      var s = i; while (i < n && !isFinite(out[i])) i++;
      var e = i, len = e - s;
      if (len > maxGap) continue;
      var L = s - 1, R = e;
      if (L >= 0 && R < n) { for (var j = s; j < e; j++) out[j] = out[L] + (out[R] - out[L]) * (j - L) / (R - L); }
      else if (L >= 0) { for (j = s; j < e; j++) out[j] = out[L]; }
      else if (R < n) { for (j = s; j < e; j++) out[j] = out[R]; }
    }
    return out;
  }

  // 中心移動平均（欠損は無視）
  function smooth(a, win) {
    if (win <= 1) return a.slice();
    var h = Math.floor(win / 2), n = a.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      if (!isFinite(a[i])) { out[i] = NaN; continue; }
      var s = 0, c = 0;
      for (var j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (isFinite(a[j])) { s += a[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }

  // 中央値フィルタ：1〜2コマだけ左右の点が入れ替わるような飛びを取り除く
  function medianFilter(a, win) {
    var h = Math.floor(win / 2), n = a.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      if (!isFinite(a[i])) { out[i] = NaN; continue; }
      var w = [];
      for (var j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (isFinite(a[j])) w.push(a[j]);
      w.sort(function (x, y) { return x - y; });
      out[i] = w[Math.floor(w.length / 2)];
    }
    return out;
  }

  function argExt(arr, a, b, useMax) {
    var bi = -1, bv = useMax ? -Infinity : Infinity;
    for (var i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) {
      var v = arr[i]; if (!isFinite(v)) continue;
      if (useMax ? v > bv : v < bv) { bv = v; bi = i; }
    }
    return bi;
  }

  // キャッチ検出：腰と足首の水平距離（シート位置）が最も近づく点。ヒステリシスで誤検出を抑える
  function detectCatches(seat, t, minSep, knee) {
    var p5 = percentile(seat, 0.05), p95 = percentile(seat, 0.95), R = p95 - p5;
    if (!isFinite(R) || R < 0.15) return [];
    var lo = p5 + 0.35 * R, hi = p5 + 0.65 * R, seg = null, out = [];
    for (var i = 0; i < seat.length; i++) {
      var v = seat[i]; if (!isFinite(v)) continue;
      if (seg) {
        if (v < seg.v) { seg.v = v; seg.i = i; }
        if (v > hi) { out.push(seg.i); seg = null; }
      } else if (v < lo) { seg = { v: v, i: i }; }
    }
    // 膝が十分に曲がっていない点はキャッチとみなさない（足首や腰の点の飛びによる誤検出を防ぐ）
    if (knee) {
      var k5 = percentile(knee, 0.05), k95 = percentile(knee, 0.95), kLim = k5 + 0.4 * (k95 - k5);
      out = out.filter(function (i) { return !(knee[i] > kLim); });
    }
    // 近すぎるキャッチは低い方を残す
    var res = [];
    out.forEach(function (i) {
      var last = res[res.length - 1];
      if (last !== undefined && t[i] - t[last] < minSep) { if (seat[i] < seat[last]) res[res.length - 1] = i; }
      else res.push(i);
    });
    return res;
  }

  // ---------- 背中の輪郭 ----------
  // 人物シルエット（マスク）上で、腰→肩の軸に沿って41か所から垂直方向に進み、体の外に出るまでの距離を測る
  // dp / dm は軸の左右それぞれの距離（動画の画素単位、届かなければ -1）。どちらが背中側かは解析時に足の向きで決める
  var BACK_N = 41;
  function backProfile(lm, mask, mw, mh, W, H) {
    if (!lm || !mask) return null;
    var h1 = lm[23], h2 = lm[24], s1 = lm[11], s2 = lm[12];
    if (!h1 || !h2 || !s1 || !s2) return null;
    var hx = (h1.x + h2.x) / 2 * mw, hy = (h1.y + h2.y) / 2 * mh, sx = (s1.x + s2.x) / 2 * mw, sy = (s1.y + s2.y) / 2 * mh;
    var ax = sx - hx, ay = sy - hy, L = Math.hypot(ax, ay);
    if (!(L > 8)) return null;
    ax /= L; ay /= L;
    var nx = ay, ny = -ax, maxS = 0.6 * L, k = W / mw, dp = [], dm = [];
    function march(px, py, dx, dy) {
      for (var st = 0; st < maxS; st += 1) {
        var x = Math.round(px + st * dx), y = Math.round(py + st * dy);
        if (x < 0 || y < 0 || x >= mw || y >= mh || mask[y * mw + x] < 0.5) return Math.round(st * k * 10) / 10;
      }
      return -1;
    }
    for (var i = 0; i < BACK_N; i++) {
      var u = i / (BACK_N - 1), px = hx + u * L * ax, py = hy + u * L * ay;
      dp.push(march(px, py, nx, ny)); dm.push(march(px, py, -nx, -ny));
    }
    return { hx: hx * k, hy: hy * (H / mh), sx: sx * k, sy: sy * (H / mh), dp: dp, dm: dm };
  }

  // 背中側の輪郭点を作る。肘が背中より後ろにある（フィニッシュ付近）と上半分は腕に隠れるので無効にする
  function backPoints(b, dir, lm, W, H) {
    if (!b) return null;
    var ax = b.sx - b.hx, ay = b.sy - b.hy, L = Math.hypot(ax, ay); if (!(L > 0)) return null;
    ax /= L; ay /= L;
    var nx = dir * ay, ny = -dir * ax, d = dir > 0 ? b.dp : b.dm;
    var upperValid = true;
    if (lm) {
      var e = vis(lm[13]) >= vis(lm[14]) ? lm[13] : lm[14];
      if (e) {
        var ex = e.x * W - b.hx, ey = e.y * H - b.hy, eu = (ex * ax + ey * ay) / L, en = ex * nx + ey * ny;
        if (en > 0.05 * L && eu > 0.25 && eu < 1.2) upperValid = false;
      }
    }
    var pts = [];
    for (var i = 0; i < d.length; i++) {
      var u = i / (d.length - 1);
      if (d[i] < 0) continue;
      if (!upperValid && u > 0.42) continue;
      pts.push({ u: u, x: b.hx + u * L * ax + d[i] * nx, y: b.hy + u * L * ay + d[i] * ny });
    }
    return { pts: pts, upperValid: upperValid, L: L, nx: nx, ny: ny };
  }

  function fitTilt(pts, lo, hi, dir) {
    var q = pts.filter(function (p) { return p.u >= lo && p.u <= hi; });
    if (q.length < 5) return NaN;
    var mx = 0, my = 0; q.forEach(function (p) { mx += p.x; my += p.y; }); mx /= q.length; my /= q.length;
    var cxx = 0, cyy = 0, cxy = 0; q.forEach(function (p) { var dx = p.x - mx, dy = p.y - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; });
    var th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), vx = Math.cos(th), vy = Math.sin(th);
    if (vy > 0) { vx = -vx; vy = -vy; }
    return Math.atan2(dir * vx, -vy) * 180 / Math.PI;
  }

  // 腰の傾き（輪郭の下側 u0.10-0.40）、胸の傾き（上側 u0.50-0.85）、背中の丸み（輪郭が腰〜胸を結ぶ直線から最も膨らんだ量÷直線の長さ）
  function backMetrics(b, dir, lm, W, H) {
    var bp = backPoints(b, dir, lm, W, H); if (!bp) return null;
    var pts = bp.pts, low = fitTilt(pts, 0.10, 0.40, dir), up = NaN, round = NaN;
    if (bp.upperValid) {
      up = fitTilt(pts, 0.50, 0.85, dir);
      var p0 = pts.filter(function (p) { return Math.abs(p.u - 0.10) < 0.013; })[0];
      var p1 = pts.filter(function (p) { return Math.abs(p.u - 0.85) < 0.013; })[0];
      var mid = pts.filter(function (p) { return p.u >= 0.10 && p.u <= 0.85; });
      if (p0 && p1 && mid.length >= 22) {
        var cx = p1.x - p0.x, cy = p1.y - p0.y, cl = Math.hypot(cx, cy), nnx = dir * cy / cl, nny = -dir * cx / cl, mxv = -Infinity;
        mid.forEach(function (p) { var v = (p.x - p0.x) * nnx + (p.y - p0.y) * nny; if (v > mxv) mxv = v; });
        round = mxv / cl * 100;
      }
    }
    return { low: low, up: up, round: round };
  }

  function analyze(frames, W, H, opts) {
    opts = opts || {};
    var n = frames.length;
    var t = frames.map(function (f) { return f.t; });
    var dur = n > 1 ? t[n - 1] - t[0] : 0;
    var fps = n > 1 ? (n - 1) / dur : 30;
    var detected = frames.filter(function (f) { return !!f.lm; }).length;
    var side = chooseSide(frames);
    var mode = opts.mode || 'near';
    var J = buildTracks(frames, W, H, mode, side);

    var maxGap = Math.round(0.5 * fps);
    var win = Math.max(1, Math.round(0.067 * fps) * 2 + 1);
    KEYS.forEach(function (k) {
      J[k].x = smooth(medianFilter(fillGaps(J[k].x, maxGap), 5), win);
      J[k].y = smooth(medianFilter(fillGaps(J[k].y, maxGap), 5), win);
    });

    // 船首方向（足の向き）: +1 なら画面右に足がある
    var dsign = [];
    for (var i = 0; i < n; i++) { var d = J.an.x[i] - J.hip.x[i]; if (isFinite(d)) dsign.push(d); }
    var dir = median(dsign) >= 0 ? 1 : -1;

    var legs = [];
    for (i = 0; i < n; i++) {
      var l = Math.hypot(J.hip.x[i] - J.kn.x[i], J.hip.y[i] - J.kn.y[i]) + Math.hypot(J.kn.x[i] - J.an.x[i], J.kn.y[i] - J.an.y[i]);
      if (isFinite(l)) legs.push(l);
    }
    var legLen = median(legs) || 1;

    var S = { knee: [], hip: [], elbow: [], trunk: [], shin: [], seat: [], hand: [] };
    for (i = 0; i < n; i++) {
      var sh = { x: J.sh.x[i], y: J.sh.y[i] }, el = { x: J.el.x[i], y: J.el.y[i] }, wr = { x: J.wr.x[i], y: J.wr.y[i] };
      var hp = { x: J.hip.x[i], y: J.hip.y[i] }, kn = { x: J.kn.x[i], y: J.kn.y[i] }, an = { x: J.an.x[i], y: J.an.y[i] };
      S.knee.push(angle3(hp.x, hp.y, kn.x, kn.y, an.x, an.y));
      S.hip.push(angle3(sh.x, sh.y, hp.x, hp.y, kn.x, kn.y));
      S.elbow.push(angle3(sh.x, sh.y, el.x, el.y, wr.x, wr.y));
      // 体幹角度：鉛直からの傾き。前傾（足側）を＋、後傾を−
      S.trunk.push(Math.atan2(dir * (sh.x - hp.x), hp.y - sh.y) * 180 / Math.PI);
      // すね角度：鉛直からの傾き。膝が足首より船首側に出ると＋（垂直を越えた詰めすぎ）
      S.shin.push(Math.atan2(dir * (kn.x - an.x), an.y - kn.y) * 180 / Math.PI);
      S.seat.push(dir * (an.x - hp.x) / legLen);
      S.hand.push(dir * (an.x - wr.x) / legLen);
    }

    // 背中の輪郭（シルエットがある場合のみ）
    S.backLow = []; S.backUp = []; S.backRound = [];
    var hasBack = false;
    for (i = 0; i < n; i++) {
      var bm = frames[i].back && frames[i].lm ? backMetrics(frames[i].back, dir, frames[i].lm, W, H) : null;
      S.backLow.push(bm ? bm.low : NaN); S.backUp.push(bm ? bm.up : NaN); S.backRound.push(bm ? bm.round : NaN);
      if (bm && isFinite(bm.low)) hasBack = true;
    }
    ['backLow', 'backUp', 'backRound'].forEach(function (k) { S[k] = smooth(fillGaps(S[k], Math.round(0.2 * fps)), win); });
    var around = function (arr, c) { return mean(arr.slice(Math.max(0, c - 2), c + 3)); };

    var catches = detectCatches(S.seat, t, 1.0, S.knee);
    var w = Math.max(1, Math.round(0.15 * fps));
    var strokes = [];
    for (var s = 0; s + 1 < catches.length; s++) {
      var ci = catches[s], cn = catches[s + 1];
      var T = t[cn] - t[ci];
      if (T > 6 || T < 1) continue;
      var fi = argExt(S.hand, ci + 1, cn - 1, true);
      if (fi < 0) fi = argExt(S.seat, ci + 1, cn - 1, true);
      if (fi < 0) continue;

      var kCatchI = argExt(S.knee, ci - w, ci + w, false);
      var kneeCatch = S.knee[kCatchI];
      var kneeMax = S.knee[argExt(S.knee, ci, fi, true)];
      var tRefI = argExt(S.trunk, ci - w, ci + w, true);
      var trunkRef = S.trunk[tRefI];
      var tMinI = argExt(S.trunk, ci, cn, false);
      var trunkMin = S.trunk[tMinI];
      var tRefNextI = argExt(S.trunk, cn - w, cn + w, true);
      var trunkRefNext = S.trunk[tRefNextI];
      var hipCatch = S.hip[argExt(S.hip, ci - w, ci + w, false)];

      var legsExt = function (j) { return clamp01((S.knee[j] - kneeCatch) / (kneeMax - kneeCatch)); };
      var trunkOpen = function (j) { return clamp01((trunkRef - S.trunk[j]) / (trunkRef - trunkMin)); };

      // 体幹が開き始めた瞬間（基準から3°以上起きた最初のフレーム）の脚の伸展率
      var jT = -1;
      for (var j = tRefI + 1; j <= fi; j++) if (S.trunk[j] <= trunkRef - 3) { jT = j; break; }
      // 脚が半分伸びた時点で、体幹がキャッチの角度からどれだけ開いているか（°と振り幅に対する%）
      var jH = -1;
      for (j = ci; j <= fi; j++) if (legsExt(j) >= 0.5) { jH = j; break; }
      // 腕が曲がり始めた瞬間（ドライブ前半の肘角度から15°以上曲がった最初のフレーム）の体幹の開き率
      var elbowRef = median(S.elbow.slice(ci, ci + Math.max(1, Math.round(0.3 * (fi - ci))) + 1));
      var jA = -1;
      for (j = ci + 1; j <= fi; j++) if (S.elbow[j] <= elbowRef - 15) { jA = j; break; }
      // リカバリー：膝が曲がり始めた瞬間（8°以上）の体幹の前傾完了率
      var kFinI = argExt(S.knee, fi - w, fi + w, true);
      var kneeFin = S.knee[kFinI], jK = -1;
      for (j = kFinI + 1; j <= cn; j++) if (S.knee[j] <= kneeFin - 8) { jK = j; break; }

      strokes.push({
        no: strokes.length + 1,
        catchIdx: ci, finishIdx: fi, nextCatchIdx: cn,
        tCatch: t[ci], tFinish: t[fi],
        rate: 60 / T,
        drive: t[fi] - t[ci],
        recovery: t[cn] - t[fi],
        ratio: (t[cn] - t[fi]) / (t[fi] - t[ci]),
        catchTrunk: trunkRef,
        finishTrunk: trunkMin,
        trunkRange: trunkRef - trunkMin,
        catchKnee: kneeCatch,
        catchShin: S.shin[kCatchI],
        catchHip: hipCatch,
        legsAtTrunk: jT >= 0 ? legsExt(jT) * 100 : NaN,
        trunkOpenHalf: jH >= 0 ? trunkRef - S.trunk[jH] : NaN,
        trunkOpenHalfPct: jH >= 0 ? trunkOpen(jH) * 100 : NaN,
        trunkAtArms: jA >= 0 ? trunkOpen(jA) * 100 : NaN,
        bodyPrepAtKnee: (jK >= 0 && isFinite(trunkRefNext)) ? clamp01((S.trunk[jK] - trunkMin) / (trunkRefNext - trunkMin)) * 100 : NaN,
        catchRound: around(S.backRound, ci),
        catchBackLow: around(S.backLow, ci),
        catchBackUp: around(S.backUp, ci),
        catchBend: around(S.backUp, ci) - around(S.backLow, ci),
        idxTrunkStart: jT, idxArmStart: jA, idxKneeBend: jK
      });
    }

    var METRICS = ['rate', 'drive', 'recovery', 'ratio', 'catchTrunk', 'finishTrunk', 'trunkRange', 'catchKnee', 'catchShin', 'catchHip', 'legsAtTrunk', 'trunkOpenHalf', 'trunkOpenHalfPct', 'trunkAtArms', 'bodyPrepAtKnee', 'catchRound', 'catchBackLow', 'catchBackUp', 'catchBend'];
    var summary = {};
    METRICS.forEach(function (m) {
      var v = strokes.map(function (s) { return s[m]; });
      summary[m] = { mean: mean(v), sd: sd(v), n: v.filter(isFinite).length };
    });

    return {
      t: t, fps: fps, duration: dur, side: side, mode: mode, dir: dir, legLen: legLen,
      detectRate: n ? detected / n : 0, joints: J, hasBack: hasBack, series: S, catches: catches,
      strokes: strokes, summary: summary, metrics: METRICS
    };
  }

  var api = { analyze: analyze, backProfile: backProfile, backPoints: backPoints, backMetrics: backMetrics, angle3: angle3, SIDE: SIDE, KEYS: KEYS, mean: mean, sd: sd, median: median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ErgAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
