/*
 * range-lib.js — pure computation core for the sftrk LoRa range-testing tool.
 * No DOM. Works both in the browser (window.RangeLib) and Node (require('./range-lib.js')).
 * The HTML page and the test suite (range-lib.test.js) both consume these functions,
 * so the math is verified by tests and never drifts from the UI.
 *
 * Constants verified against:
 *  - FSPL 32.44 (d km, f MHz); haversine R = 6371008.8 m
 *  - SX1262 datasheet Table 3-8 (RX Boosted, CR 4/5): SF7=-124, SF12=-137 dBm @125kHz
 *  - Semtech LoRa airtime model; SX1262 preamble offset = 6.25 (2 symbols more than SX127x)
 *  - Fresnel midpoint 8.657*sqrt(d_km/f_GHz); 4/3-earth radio horizon 4.12*(sqrt h1 + sqrt h2)
 */
(function (global) {
  'use strict';

  var log10 = function (x) { return Math.log(x) / Math.LN10; };

  // SX1262 RX sensitivity (dBm, BW=125 kHz, CR=4/5, RX Boosted). SF7/SF12 are datasheet
  // exact; SF8..SF11 interpolated on the datasheet anchors.
  var SENSITIVITY_125K = { 7: -124, 8: -127, 9: -130, 10: -133, 11: -135.5, 12: -137 };

  /* ---- haversine: great-circle distance (m) + initial bearing (deg) ---- */
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371008.8, rad = Math.PI / 180;
    var p1 = lat1 * rad, p2 = lat2 * rad,
        dp = (lat2 - lat1) * rad, dl = (lng2 - lng1) * rad;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    var dist = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var brg = (Math.atan2(y, x) / rad + 360) % 360;
    return { dist: dist, brg: brg };
  }

  /* ---- link budget -> theoretical free-space range ---- */
  // o: {f (MHz), ptx, gt, gr, loss, sens (dBm, negative), fade}
  function linkBudget(o) {
    var maxPL = o.ptx + o.gt + o.gr - o.loss - o.fade - o.sens;     // dB available to path
    var rangeKm = Math.pow(10, (maxPL - 32.44 - 20 * log10(o.f)) / 20);
    var eirp = o.ptx + o.gt - o.loss / 2;
    var margin = o.ptx + o.gt + o.gr - o.loss - o.sens;             // over bare sensitivity
    return { maxPL: maxPL, rangeKm: rangeKm, eirp: eirp, margin: margin };
  }

  /* ---- Fresnel zone + 4/3-earth radio horizon ---- */
  // o: {f (MHz), d (km), h1 (m), h2 (m)}
  function fresnel(o) {
    var fGHz = o.f / 1000;
    var F1 = 8.657 * Math.sqrt(o.d / fGHz);          // 1st Fresnel radius at midpoint (m)
    var clear60 = 0.6 * F1;
    var horizon = 4.12 * (Math.sqrt(o.h1) + Math.sqrt(o.h2)); // km
    return { F1: F1, clear60: clear60, horizon: horizon, beyond: o.d > horizon };
  }

  /* ---- LoRa time on air (Semtech model) ---- */
  // o: {sf, bw (kHz), cr (1..4 => 4/5..4/8), pl (bytes), npre, ih (0 explicit /1 implicit),
  //     crc (1 on/0 off), ldro (-1 auto / 1 / 0), preambleOffset (default 6.25 for SX1262),
  //     period (s, optional)}
  function timeOnAir(o) {
    var bw = o.bw * 1000;
    var Tsym = Math.pow(2, o.sf) / bw;                          // s
    var de = (o.ldro === -1) ? (Tsym > 0.016 ? 1 : 0) : o.ldro; // auto: symbol time > 16 ms
    var preOff = (o.preambleOffset == null) ? 6.25 : o.preambleOffset;
    var preT = (o.npre + preOff) * Tsym;
    var numer = 8 * o.pl - 4 * o.sf + 28 + 16 * o.crc - 20 * o.ih;
    var denom = 4 * (o.sf - 2 * de);
    var payloadSymb = 8 + Math.max(Math.ceil(numer / denom) * (o.cr + 4), 0);
    var payloadT = payloadSymb * Tsym;
    var toaMs = (preT + payloadT) * 1000;
    var maxRate = 1000 / toaMs;
    var duty = o.period ? (toaMs / (o.period * 1000)) * 100 : null;
    return { Tsym: Tsym, de: de, payloadSymb: payloadSymb, toaMs: toaMs,
             maxRate: maxRate, duty: duty };
  }

  /* ---- CSV parsing + log processing (pure: data in, points out) ---- */
  function parseCSV(text) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim().length; });
    var head = lines[0].split(',').map(function (s) { return s.trim(); });
    var idx = {};
    head.forEach(function (h, i) { idx[h.toLowerCase()] = i; });
    var rows = lines.slice(1).map(function (l) { return l.split(','); });
    return { head: head, idx: idx, rows: rows };
  }

  // first matching column index, else -1
  function pickCol(idx) {
    for (var i = 1; i < arguments.length; i++) {
      if (arguments[i] in idx) return idx[arguments[i]];
    }
    return -1;
  }

  function hasTxColumns(idx) {
    return pickCol(idx, 'tx_late7', 'tx_lat_e7', 'tx_lat') !== -1 &&
           pickCol(idx, 'tx_lnge7', 'tx_lng_e7', 'tx_lng', 'tx_lon') !== -1;
  }

  // idx: header map, rows: string[][], ref: {lat,lng} | null (used when no tx_* columns)
  // V2 columns (rx_late7/tx_late7/rx_rssix10/latency_us…) are preferred; V1 aliases
  // (lat_e7/tx_lat_e7/rssi_dbm/tx_gps_us…) remain as a fallback so legacy logs still load.
  function processRows(idx, rows, ref) {
    var ci = {
      rxLat:  pickCol(idx, 'rx_late7', 'rx_lat_e7', 'lat_e7', 'rx_lat'),
      rxLng:  pickCol(idx, 'rx_lnge7', 'rx_lng_e7', 'lng_e7', 'rx_lng', 'lon_e7'),
      txLat:  pickCol(idx, 'tx_late7', 'tx_lat_e7', 'tx_lat'),
      txLng:  pickCol(idx, 'tx_lnge7', 'tx_lng_e7', 'tx_lng', 'tx_lon'),
      rssi:   pickCol(idx, 'rx_rssix10', 'rssi_dbm', 'rssi'),
      snr:    pickCol(idx, 'rx_snrx10', 'snr_db', 'snr'),
      pid:    pickCol(idx, 'packet_id', 'pid'),
      latencyUs: pickCol(idx, 'latency_us'),
      txGpsUs:   pickCol(idx, 'tx_gps_us'),   // V1 legacy: two GPS-PPS timestamps
      rxGpsUs:   pickCol(idx, 'rx_gps_us')
    };
    // V2 stores RSSI/SNR as int × 10 (dBm×10 / dB×10). Detect by column name so
    // legacy float-dBm columns keep their value.
    var rssiX10 = 'rx_rssix10' in idx;
    var snrX10  = 'rx_snrx10'  in idx;
    var E7  = function (v) { return parseFloat(v) / 1e7; };
    var x10 = function (v) { return parseInt(v, 10) / 10; };
    var out = [];
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var rxLat = ci.rxLat >= 0 ? E7(r[ci.rxLat]) : NaN;
      var rxLng = ci.rxLng >= 0 ? E7(r[ci.rxLng]) : NaN;
      var txLat, txLng;
      if (ci.txLat >= 0) { txLat = E7(r[ci.txLat]); txLng = E7(r[ci.txLng]); }
      else if (ref) { txLat = ref.lat; txLng = ref.lng; }
      else continue;
      if (![rxLat, rxLng, txLat, txLng].every(isFinite)) continue;
      if (rxLat === 0 && rxLng === 0) continue;   // RX no-fix sentinel
      if (txLat === 0 && txLng === 0) continue;    // TX no-fix sentinel (verified guard)
      var h = haversine(rxLat, rxLng, txLat, txLng);
      var rssi = ci.rssi >= 0 ? (rssiX10 ? x10(r[ci.rssi]) : parseFloat(r[ci.rssi])) : NaN;
      var snr  = ci.snr  >= 0 ? (snrX10  ? x10(r[ci.snr])  : parseFloat(r[ci.snr]))  : NaN;
      var pid  = ci.pid  >= 0 ? parseInt(r[ci.pid], 10) : NaN;
      // Latency. V2: single uint32 latency_us round-trip (REQ_LOG TX_DONE →
      // LocationPacket RX_DONE), local micros() — fits in Number (max ~4.3e9
      // < 2^53), no BigInt needed. V1 fallback: two uint64 GPS-PPS timestamps
      // via BigInt subtraction (legacy logs).
      var latencyMs = NaN;
      if (ci.latencyUs >= 0) {
        var usStr = r[ci.latencyUs];
        if (usStr) {
          var us = parseInt(usStr, 10);
          if (isFinite(us)) latencyMs = us / 1000;
        }
      } else if (ci.txGpsUs >= 0 && ci.rxGpsUs >= 0) {
        var txStr = r[ci.txGpsUs];
        var rxStr = r[ci.rxGpsUs];
        if (txStr && rxStr) {
          try {
            var diff = BigInt(rxStr) - BigInt(txStr);
            latencyMs = Number(diff) / 1000;
          } catch (e) {
            latencyMs = NaN;
          }
        }
      }
      out.push({ rxLat: rxLat, rxLng: rxLng, txLat: txLat, txLng: txLng,
                 dist: h.dist, brg: h.brg, rssi: rssi, snr: snr, pid: pid,
                 latencyMs: latencyMs });
    }
    return out;
  }

  // aggregate stats for a processed point list
  function summarize(points) {
    if (!points.length) return null;
    var dists = points.map(function (p) { return p.dist; });
    var rssis = points.map(function (p) { return p.rssi; }).filter(isFinite);
    var pids = points.map(function (p) { return p.pid; }).filter(isFinite);
    var latencies = points.map(function (p) { return p.latencyMs; }).filter(isFinite);
    var pdr = null;
    if (pids.length) {
      var span = Math.max.apply(null, pids) - Math.min.apply(null, pids) + 1;
      pdr = pids.length / span * 100;
    }
    return {
      count: points.length,
      maxDist: Math.max.apply(null, dists),
      meanDist: dists.reduce(function (a, b) { return a + b; }, 0) / points.length,
      bestRssi: rssis.length ? Math.max.apply(null, rssis) : null,
      worstRssi: rssis.length ? Math.min.apply(null, rssis) : null,
      pdr: pdr,
      meanLatency: latencies.length ? latencies.reduce(function (a, b) { return a + b; }, 0) / latencies.length : null,
      maxLatency: latencies.length ? Math.max.apply(null, latencies) : null
    };
  }

  function rssiColor(r) {
    if (!isFinite(r)) return '#6a6078';
    if (r >= -90) return '#7a9e7e';
    if (r >= -105) return '#a094b8';
    if (r >= -115) return '#e8a840';
    if (r >= -125) return '#c48030';
    return '#c04040';
  }

  // qualitative RSSI bucket — a non-color signal to pair with rssiColor (a11y)
  function rssiBucket(r) {
    if (!isFinite(r)) return 'n/a';
    if (r >= -90) return 'strong';
    if (r >= -105) return 'good';
    if (r >= -115) return 'fair';
    if (r >= -125) return 'weak';
    return 'floor';
  }

  /* ---- filtering / brushing (single source of truth for the UI) ---- */
  // A null/absent range means "no constraint" on that field. A non-finite field
  // value is dropped ONLY when that field is actually constrained.
  function inRange(v, range) {
    if (!range) return true;
    if (!isFinite(v)) return false;
    return v >= range[0] && v <= range[1];
  }
  // ranges: {dist:[lo,hi]|null, rssi:[lo,hi]|null, snr:[lo,hi]|null, pid:[lo,hi]|null}
  function filterPoints(points, ranges) {
    ranges = ranges || {};
    return points.filter(function (p) {
      return inRange(p.dist, ranges.dist) &&
             inRange(p.rssi, ranges.rssi) &&
             inRange(p.snr,  ranges.snr)  &&
             inRange(p.pid,  ranges.pid);
    });
  }

  // {min,max} over finite values of a key, or null if none. Inits slider bounds.
  function valueRange(points, key) {
    var vals = [];
    for (var i = 0; i < points.length; i++) {
      var v = points[i][key];
      if (isFinite(v)) vals.push(v);
    }
    if (!vals.length) return null;
    return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }

  /* ---- generic 1-D binning ---- */
  // opts: {min?, max?, bins?}. Returns [{x0, x1, count}]. Non-finite values ignored.
  function histogram(values, opts) {
    opts = opts || {};
    var finite = values.filter(isFinite);
    if (!finite.length) return [];
    var bins = opts.bins != null ? opts.bins : 10;
    if (bins < 1) bins = 1;
    var min = (opts.min != null && isFinite(opts.min)) ? opts.min : Math.min.apply(null, finite);
    var max = (opts.max != null && isFinite(opts.max)) ? opts.max : Math.max.apply(null, finite);
    if (max < min) { var t = min; min = max; max = t; }   // tolerate an inverted window
    if (max === min) return [{ x0: min, x1: max, count: finite.length }];
    var width = (max - min) / bins;
    var out = [];
    for (var b = 0; b < bins; b++) out.push({ x0: min + b * width, x1: min + (b + 1) * width, count: 0 });
    for (var i = 0; i < finite.length; i++) {
      var v = finite[i];
      if (v < min || v > max) continue;
      var bi = Math.floor((v - min) / width);
      if (bi >= bins) bi = bins - 1;   // the max value lands in the last bin
      if (bi < 0) bi = 0;
      out[bi].count++;
    }
    return out;
  }

  /* ---- spatial binning for the map heatmap (pure; no Leaflet) ---- */
  // opts: {cellMeters?}. Grid is anchored at (0,0) for deterministic cell ids;
  // longitude metres-per-degree uses cos(centroid latitude) (local equirectangular).
  // Each cell: {lat, lng (centre), count, meanRssi, meanSnr} — means over finite values.
  function gridBins(points, opts) {
    opts = opts || {};
    var pts = points.filter(function (p) { return isFinite(p.rxLat) && isFinite(p.rxLng); });
    if (!pts.length) return [];
    var sumLat = 0;
    for (var i = 0; i < pts.length; i++) sumLat += pts[i].rxLat;
    var cLat = sumLat / pts.length;
    var mPerDegLat = 111320;
    var mPerDegLng = 111320 * Math.cos(cLat * Math.PI / 180);
    var cell = opts.cellMeters || 100;
    var dLat = cell / mPerDegLat;
    var dLng = cell / (Math.abs(mPerDegLng) < 1e-9 ? 1e-9 : mPerDegLng);
    var cells = {};
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      var gi = Math.floor(p.rxLat / dLat);
      var gj = Math.floor(p.rxLng / dLng);
      var key = gi + ':' + gj;
      if (!cells[key]) cells[key] = { gi: gi, gj: gj, count: 0, rssis: [], snrs: [] };
      cells[key].count++;
      if (isFinite(p.rssi)) cells[key].rssis.push(p.rssi);
      if (isFinite(p.snr)) cells[key].snrs.push(p.snr);
    }
    var mean = function (a) {
      if (!a.length) return null;
      return a.reduce(function (x, y) { return x + y; }, 0) / a.length;
    };
    var out = [];
    var keys = Object.keys(cells).sort();   // deterministic order
    for (var n = 0; n < keys.length; n++) {
      var c = cells[keys[n]];
      out.push({
        lat: (c.gi + 0.5) * dLat,
        lng: (c.gj + 0.5) * dLng,
        count: c.count,
        meanRssi: mean(c.rssis),
        meanSnr: mean(c.snrs)
      });
    }
    return out;
  }

  /* ---- multi-session comparison ---- */
  // sessions: [{name, summary}] where summary is a summarize() result (or null).
  // Returns {names, metrics:[{key, dir, values:[...], bestIdx, worstIdx}]}.
  // dir = +1 higher-is-better, -1 lower-is-better. worstRssi dir=+1 (a higher
  // noise-floor RSSI is the better floor). Flags only set when >1 session and >1
  // finite value, and suppressed when every finite value ties.
  function compareSessions(sessions) {
    var METRICS = [
      { key: 'count',       dir:  1 },
      { key: 'maxDist',     dir:  1 },
      { key: 'meanDist',    dir:  1 },
      { key: 'bestRssi',    dir:  1 },
      { key: 'worstRssi',   dir:  1 },
      { key: 'pdr',         dir:  1 },
      { key: 'meanLatency', dir: -1 },
      { key: 'maxLatency',  dir: -1 }
    ];
    var names = sessions.map(function (s) { return s.name; });
    var metrics = METRICS.map(function (m) {
      var values = sessions.map(function (s) {
        var v = s.summary ? s.summary[m.key] : null;
        return (v == null || !isFinite(v)) ? null : v;
      });
      var finiteIdx = [];
      values.forEach(function (v, i) { if (v != null) finiteIdx.push(i); });
      var bestIdx = -1, worstIdx = -1;
      if (sessions.length > 1 && finiteIdx.length > 1) {
        var bestScore = null, worstScore = null;
        finiteIdx.forEach(function (i) {
          var score = values[i] * m.dir;
          if (bestScore === null || score > bestScore) { bestScore = score; bestIdx = i; }
          if (worstScore === null || score < worstScore) { worstScore = score; worstIdx = i; }
        });
        if (bestScore === worstScore) { bestIdx = -1; worstIdx = -1; }  // all tied
      }
      return { key: m.key, dir: m.dir, values: values, bestIdx: bestIdx, worstIdx: worstIdx };
    });
    return { names: names, metrics: metrics };
  }

  /* ---- log-distance path-loss fit: RSSI = intercept - 10·n·log10(d) ---- */
  // Least-squares of rssi vs log10(dist), ignoring non-finite/zero-distance rows.
  // Returns {n (path-loss exponent), intercept, slope, r2} or null if <2 usable.
  function pathLossFit(points) {
    var xs = [], ys = [];
    for (var i = 0; i < points.length; i++) {
      var d = points[i].dist, r = points[i].rssi;
      if (!isFinite(d) || d <= 0 || !isFinite(r)) continue;
      xs.push(log10(d));
      ys.push(r);
    }
    var n = xs.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (var k = 0; k < n; k++) {
      sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; syy += ys[k] * ys[k];
    }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;       // all points at one distance
    var slope = (n * sxy - sx * sy) / denom;
    var intercept = (sy - slope * sx) / n;
    var meanY = sy / n;
    var ssTot = syy - n * meanY * meanY;
    var ssRes = 0;
    for (var j = 0; j < n; j++) {
      var pred = slope * xs[j] + intercept;
      ssRes += (ys[j] - pred) * (ys[j] - pred);
    }
    var r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { n: -slope / 10, intercept: intercept, slope: slope, r2: r2 };
  }

  /* ---- summary -> Markdown table (for "copy summary" export) ---- */
  function summaryToMarkdown(summary, name) {
    var title = name ? ('### ' + name + '\n\n') : '';
    if (!summary) return title + '_No data._\n';
    var dist = function (m) {
      if (m == null || !isFinite(m)) return '—';
      return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
    };
    var unit = function (v, u, dec) {
      if (v == null || !isFinite(v)) return '—';
      return (dec != null ? v.toFixed(dec) : v) + (u || '');
    };
    var rows = [
      ['Packets', String(summary.count)],
      ['Max range', dist(summary.maxDist)],
      ['Mean range', dist(summary.meanDist)],
      ['Best RSSI', unit(summary.bestRssi, ' dBm', 0)],
      ['Worst RSSI', unit(summary.worstRssi, ' dBm', 0)],
      ['Delivery ratio', unit(summary.pdr, ' %', 1)],
      ['Mean latency', unit(summary.meanLatency, ' ms', 1)],
      ['Max latency', unit(summary.maxLatency, ' ms', 1)]
    ];
    var md = title + '| Metric | Value |\n| --- | --- |\n';
    rows.forEach(function (r) { md += '| ' + r[0] + ' | ' + r[1] + ' |\n'; });
    return md;
  }

  var RangeLib = {
    SENSITIVITY_125K: SENSITIVITY_125K,
    haversine: haversine,
    linkBudget: linkBudget,
    fresnel: fresnel,
    timeOnAir: timeOnAir,
    parseCSV: parseCSV,
    pickCol: pickCol,
    hasTxColumns: hasTxColumns,
    processRows: processRows,
    summarize: summarize,
    rssiColor: rssiColor,
    rssiBucket: rssiBucket,
    filterPoints: filterPoints,
    valueRange: valueRange,
    histogram: histogram,
    gridBins: gridBins,
    compareSessions: compareSessions,
    pathLossFit: pathLossFit,
    summaryToMarkdown: summaryToMarkdown
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RangeLib;
  else global.RangeLib = RangeLib;

})(typeof window !== 'undefined' ? window : globalThis);
