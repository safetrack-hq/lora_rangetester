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
    return pickCol(idx, 'tx_lat_e7', 'tx_lat') !== -1 &&
           pickCol(idx, 'tx_lng_e7', 'tx_lng', 'tx_lon') !== -1;
  }

  // idx: header map, rows: string[][], ref: {lat,lng} | null (used when no tx_* columns)
  function processRows(idx, rows, ref) {
    var ci = {
      rxLat:  pickCol(idx, 'rx_lat_e7', 'lat_e7', 'rx_lat'),
      rxLng:  pickCol(idx, 'rx_lng_e7', 'lng_e7', 'rx_lng', 'lon_e7'),
      txLat:  pickCol(idx, 'tx_lat_e7', 'tx_lat'),
      txLng:  pickCol(idx, 'tx_lng_e7', 'tx_lng', 'tx_lon'),
      rssi:   pickCol(idx, 'rssi_dbm', 'rssi'),
      snr:    pickCol(idx, 'snr_db', 'snr'),
      pid:    pickCol(idx, 'packet_id', 'pid'),
      txGpsUs: pickCol(idx, 'tx_gps_us'),
      rxGpsUs: pickCol(idx, 'rx_gps_us')
    };
    var E7 = function (v) { return parseFloat(v) / 1e7; };
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
      var rssi = ci.rssi >= 0 ? parseFloat(r[ci.rssi]) : NaN;
      var snr = ci.snr >= 0 ? parseFloat(r[ci.snr]) : NaN;
      var pid = ci.pid >= 0 ? parseInt(r[ci.pid], 10) : NaN;
      // Latency: BigInt subtraction to avoid floating-point precision loss
      // at large Unix-µs magnitudes (~1.78e15 in 2026). Result is a small
      // number (~1.2e6 for 1.2 s airtime) which converts cleanly to ms.
      var latencyMs = NaN;
      if (ci.txGpsUs >= 0 && ci.rxGpsUs >= 0) {
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
    rssiColor: rssiColor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RangeLib;
  else global.RangeLib = RangeLib;

})(typeof window !== 'undefined' ? window : globalThis);
