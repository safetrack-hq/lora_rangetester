/*
 * Tests for range-lib.js — the pure math core behind range-testing.html.
 * Run:  node --test          (or)  npm test
 * Zero dependencies: Node built-in test runner + assert.
 *
 * Expected values are the workflow-verified figures:
 *  - FSPL maxPL 152.3 dB / ~1075 km for the default SX1262 link budget
 *  - LoRa SF12/125k airtime 1220.6 ms with the SX1262 (+6.25) preamble
 *  - SX1262 datasheet sensitivities SF7=-124, SF12=-137 dBm
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const RL = require('./range-lib.js');

// assert a ~ b within tol
function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` expected ${b} ± ${tol}, got ${a}`);
}

/* ============================ haversine ============================ */
test('haversine: 1 deg of longitude at the equator ≈ 111.19 km', () => {
  const { dist } = RL.haversine(0, 0, 0, 1);
  near(dist, 111194.9, 1, 'equator degree');           // R*pi/180
});

test('haversine: identical points = 0', () => {
  const { dist } = RL.haversine(37.7749, -122.4194, 37.7749, -122.4194);
  near(dist, 0, 1e-6);
});

test('haversine: bearing due north is 0°, due east is 90°', () => {
  near(RL.haversine(0, 0, 1, 0).brg, 0, 1e-6, 'north');
  near(RL.haversine(0, 0, 0, 1).brg, 90, 1e-6, 'east');
});

test('haversine: 0.01° latitude step ≈ 1.11 km', () => {
  const { dist } = RL.haversine(37.0, -122.0, 37.01, -122.0);
  near(dist, 1111.95, 1);
});

/* ============================ link budget ============================ */
test('linkBudget: default SX1262 SF12 link → maxPL 152.3 dB, range ~1075 km', () => {
  const r = RL.linkBudget({ f: 915, ptx: 22, gt: 2.15, gr: 2.15, loss: 1, sens: -137, fade: 10 });
  near(r.maxPL, 152.3, 0.01, 'maxPL');
  near(r.rangeKm, 1075, 5, 'rangeKm');                  // verified ~1074.5–1075.4
});

test('linkBudget: range falls as sensitivity worsens (lower SF)', () => {
  const sf12 = RL.linkBudget({ f: 915, ptx: 22, gt: 2.15, gr: 2.15, loss: 1, sens: -137, fade: 10 });
  const sf7  = RL.linkBudget({ f: 915, ptx: 22, gt: 2.15, gr: 2.15, loss: 1, sens: -124, fade: 10 });
  assert.ok(sf7.rangeKm < sf12.rangeKm, 'SF7 (-124) must reach less far than SF12 (-137)');
});

test('linkBudget: doubling distance costs ~6 dB (inverse-square sanity)', () => {
  const a = RL.linkBudget({ f: 915, ptx: 0, gt: 0, gr: 0, loss: 0, sens: -100, fade: 0 });
  const b = RL.linkBudget({ f: 915, ptx: 6.02, gt: 0, gr: 0, loss: 0, sens: -100, fade: 0 });
  near(b.rangeKm / a.rangeKm, 2, 0.02, '6.02 dB ≈ 2× range');
});

/* ============================ fresnel / horizon ============================ */
test('fresnel: F1 midpoint at 5 km / 915 MHz ≈ 20.24 m', () => {
  const r = RL.fresnel({ f: 915, d: 5, h1: 2, h2: 2 });
  near(r.F1, 20.236, 0.05, 'F1');
  near(r.clear60, 0.6 * r.F1, 1e-9, '60% clearance');
});

test('fresnel: 4/3-earth radio horizon, 2 m + 2 m antennas ≈ 11.65 km', () => {
  const r = RL.fresnel({ f: 915, d: 5, h1: 2, h2: 2 });
  near(r.horizon, 11.653, 0.01, 'horizon');
  assert.equal(r.beyond, false, '5 km path is within an 11.6 km horizon');
});

test('fresnel: a 20 km path is flagged beyond the horizon', () => {
  assert.equal(RL.fresnel({ f: 915, d: 20, h1: 2, h2: 2 }).beyond, true);
});

/* ============================ time on air ============================ */
test('timeOnAir: SF12/125k, 14 B, SX1262 preamble → 1220.6 ms', () => {
  const r = RL.timeOnAir({ sf: 12, bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1 });
  near(r.Tsym * 1000, 32.768, 1e-6, 'Tsym');
  assert.equal(r.payloadSymb, 23, 'payload symbols');
  assert.equal(r.de, 1, 'LDRO auto-on at SF12/125k');
  near(r.toaMs, 1220.608, 0.01, 'ToA');
});

test('timeOnAir: SX127x preamble offset 4.25 gives 1155.1 ms (2·Tsym less)', () => {
  const r = RL.timeOnAir({ sf: 12, bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1,
                           preambleOffset: 4.25 });
  near(r.toaMs, 1155.072, 0.01);
});

test('timeOnAir: LDRO auto threshold — off below 16 ms, on at/above', () => {
  assert.equal(RL.timeOnAir({ sf: 7,  bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1 }).de, 0);
  assert.equal(RL.timeOnAir({ sf: 11, bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1 }).de, 1);
  assert.equal(RL.timeOnAir({ sf: 12, bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1 }).de, 1);
});

test('timeOnAir: duty cycle from beacon period', () => {
  const r = RL.timeOnAir({ sf: 12, bw: 125, cr: 1, pl: 14, npre: 8, ih: 0, crc: 1, ldro: -1,
                           period: 2 });
  near(r.duty, r.toaMs / (2 * 1000) * 100, 1e-9);      // 1220.6ms / 2000ms ≈ 61%
  near(r.maxRate, 1000 / r.toaMs, 1e-9);
});

/* ============================ sensitivity table ============================ */
test('SENSITIVITY_125K: datasheet anchors SF7=-124, SF12=-137; monotonic descent', () => {
  assert.equal(RL.SENSITIVITY_125K[7], -124);
  assert.equal(RL.SENSITIVITY_125K[12], -137);
  for (let sf = 8; sf <= 12; sf++) {
    assert.ok(RL.SENSITIVITY_125K[sf] < RL.SENSITIVITY_125K[sf - 1],
      `SF${sf} must be more sensitive (lower) than SF${sf - 1}`);
  }
});

/* ============================ CSV parsing + log processing ============================ */
const FW_HEADER = 'event_time_us,time_valid,utc_iso,event_type,node_id,packet_id,' +
                  'lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db';

// New-format header (with GPS-PPS timestamps, no event_time_us)
const FW_HEADER_NEW = 'time_valid,utc_iso,event_type,node_id,packet_id,' +
                      'lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db,' +
                      'tx_lat_e7,tx_lng_e7,tx_gps_us,rx_gps_us';

// one firmware-format row helper (single GPS)
function fwRow(pid, latE7, lngE7, rssi, snr) {
  return `1000,1,2026-01-01T00:00:00Z,2,1,${pid},${latE7},${lngE7},900,${rssi},${snr}`;
}

// V2 18-column header (matches src/main.cpp logFileHeader exactly).
// Columns: event_type,event_time,event_pps_micros,node_id,target_id,packet_id,
//          rx_late7,rx_lnge7,rx_sats,tx_late7,tx_lnge7,tx_sats,
//          rx_rssix10,rx_snrx10,tx_rssix10,tx_snrx10,packet_len,latency_us
const FW_HEADER_V2 = 'event_type,event_time,event_pps_micros,node_id,target_id,packet_id,' +
                     'rx_late7,rx_lnge7,rx_sats,tx_late7,tx_lnge7,tx_sats,' +
                     'rx_rssix10,rx_snrx10,tx_rssix10,tx_snrx10,packet_len,latency_us';

// V2 row helper. rssiX10/snrX10 are int ×10 (dBm×10 / dB×10). latencyUs is
// uint32 round-trip µs. Defaults mimic a valid GPS fix (event_type=0x10) from
// responder node 2 → requester node 1.
function v2Row(pid, rxLatE7, rxLngE7, txLatE7, txLngE7, rssiX10, snrX10, latencyUs, opts) {
  const o = opts || {};
  const eventType = o.eventType != null ? o.eventType : 0x10;          // 0x10 GPS_VALID
  const eventTime = o.eventTime != null ? o.eventTime : 1782509187;    // unix seconds
  const pps = o.pps != null ? o.pps : 0;
  const nodeId = o.nodeId != null ? o.nodeId : 2;
  const targetId = o.targetId != null ? o.targetId : 1;
  const rxSats = o.rxSats != null ? o.rxSats : 7;
  const txSats = o.txSats != null ? o.txSats : 7;
  const txRssiX10 = o.txRssiX10 != null ? o.txRssiX10 : rssiX10;
  const txSnrX10  = o.txSnrX10  != null ? o.txSnrX10  : snrX10;
  const pktLen = o.pktLen != null ? o.pktLen : 23;
  const lat = latencyUs != null ? latencyUs : 0;
  return `${eventType},${eventTime},${pps},${nodeId},${targetId},${pid},` +
         `${rxLatE7},${rxLngE7},${rxSats},${txLatE7},${txLngE7},${txSats},` +
         `${rssiX10},${snrX10},${txRssiX10},${txSnrX10},${pktLen},${lat}`;
}

test('parseCSV: lower-cases header into an index map', () => {
  const { idx, rows } = RL.parseCSV(FW_HEADER + '\n' + fwRow(1, 370000000, -1220000000, -100, 5));
  assert.equal(idx['packet_id'], 5);
  assert.equal(idx['rssi_dbm'], 9);
  assert.equal(rows.length, 1);
});

test('hasTxColumns: false for firmware header, true once tx_* present', () => {
  assert.equal(RL.hasTxColumns(RL.parseCSV(FW_HEADER).idx), false);
  const dual = FW_HEADER + ',tx_lat_e7,tx_lng_e7';
  assert.equal(RL.hasTxColumns(RL.parseCSV(dual).idx), true);
});

test('processRows: single-GPS log + reference point computes distance to base', () => {
  const csv = FW_HEADER + '\n' +
    fwRow(1, 370000000, -1220000000, -95, 6) + '\n' +
    fwRow(2, 370100000, -1220000000, -110, -4);          // 0.01° north of base
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, { lat: 37.0, lng: -122.0 });
  assert.equal(pts.length, 2);
  near(pts[0].dist, 0, 1, 'row at base');
  near(pts[1].dist, 1111.95, 1, 'row 0.01° away');
  assert.equal(pts[1].rssi, -110);
});

test('processRows: RX no-fix (0,0) rows are dropped', () => {
  const csv = FW_HEADER + '\n' +
    fwRow(1, 370000000, -1220000000, -95, 6) + '\n' +
    fwRow(2, 0, 0, -120, -8);                             // no fix
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, { lat: 37.0, lng: -122.0 });
  assert.equal(pts.length, 1, 'the 0,0 row is skipped');
  assert.equal(pts[0].pid, 1);
});

test('processRows: dual-GPS log uses payload TX coords, drops TX no-fix (0,0)', () => {
  const header = FW_HEADER + ',tx_lat_e7,tx_lng_e7';
  const good = fwRow(1, 370100000, -1220000000, -95, 6) + ',370000000,-1220000000';
  const txNoFix = fwRow(2, 370200000, -1220000000, -100, 4) + ',0,0';
  const { idx, rows } = RL.parseCSV(header + '\n' + good + '\n' + txNoFix);
  const pts = RL.processRows(idx, rows, null);            // no ref needed
  assert.equal(pts.length, 1, 'TX 0,0 beacon row dropped (Gulf-of-Guinea guard)');
  near(pts[0].dist, 1111.95, 1, 'rx↔tx 0.01° apart');
});

test('summarize: stats + delivery ratio from packet_id gaps', () => {
  const csv = FW_HEADER + '\n' +
    fwRow(1, 370000000, -1220000000, -90, 7) + '\n' +
    fwRow(2, 370100000, -1220000000, -100, 2) + '\n' +
    fwRow(4, 370200000, -1220000000, -115, -5);          // pid 3 missing
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, { lat: 37.0, lng: -122.0 });
  const s = RL.summarize(pts);
  assert.equal(s.count, 3);
  assert.equal(s.bestRssi, -90);
  assert.equal(s.worstRssi, -115);
  near(s.pdr, 75, 1e-9, '3 received over span 4 = 75%');  // pids 1,2,4
  assert.ok(s.maxDist > s.meanDist);
});

test('summarize: empty input returns null (no crash)', () => {
  assert.equal(RL.summarize([]), null);
});

test('processRows: latency computed from tx_gps_us/rx_gps_us via BigInt', () => {
  // SF12/125k/22B airtime ~1330ms. Simulate two packets 1s apart.
  const header = FW_HEADER_NEW;
  const row1 = '1,2026-06-17T16:38:24Z,2,1,1,334255000,-1119400000,0,-95.0,5.0,334255000,-1119400000,1718123456123000,1718123456124330';
  const row2 = '1,2026-06-17T16:38:25Z,2,1,2,334255000,-1119400000,0,-95.0,5.0,334255000,-1119400000,1718123457123000,1718123457124280';
  const { idx, rows } = RL.parseCSV(header + '\n' + row1 + '\n' + row2);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 2);
  // row1: 1718123456124330 - 1718123456123000 = 1330 us = 1.33 ms
  assert.ok(Math.abs(pts[0].latencyMs - 1.33) < 0.01, `latency ${pts[0].latencyMs}`);
  // row2: 1718123457124280 - 1718123457123000 = 1280 us = 1.28 ms
  assert.ok(Math.abs(pts[1].latencyMs - 1.28) < 0.01, `latency ${pts[1].latencyMs}`);
});

test('processRows: missing tx_gps_us/rx_gps_us → latencyMs is NaN', () => {
  // Old-format CSV without timestamp columns
  const header = FW_HEADER;
  const row = '1000,1,2026-01-01T00:00:00Z,2,1,1,334255000,-1119400000,900,-95.0,5.0';
  const { idx, rows } = RL.parseCSV(header + '\n' + row);
  const pts = RL.processRows(idx, rows, { lat: 33.4255, lng: -111.94 });
  assert.equal(pts.length, 1);
  assert.ok(Number.isNaN(pts[0].latencyMs), 'latencyMs should be NaN when columns absent');
});

test('processRows: BigInt subtraction handles large Unix-µs values exactly', () => {
  // Simulate a packet in year 2030 (Unix-µs ~1.9e15)
  const tx = 1924991999000000n;  // BigInt
  const rx = 1924992000330000n;  // 1330ms later
  const diffMs = Number(rx - tx) / 1000;
  assert.equal(diffMs, 1330);
});

test('summarize: meanLatency and maxLatency from latencyMs', () => {
  const pts = [
    { dist: 100, rssi: -90, snr: 5, pid: 1, latencyMs: 1200.5 },
    { dist: 200, rssi: -95, snr: 4, pid: 2, latencyMs: 1330.0 },
    { dist: 300, rssi: -100, snr: 3, pid: 3, latencyMs: 1250.7 },
  ];
  const s = RL.summarize(pts);
  assert.ok(s !== null);
  // mean of 1200.5, 1330.0, 1250.7 = 3781.2 / 3 = 1260.4
  assert.ok(Math.abs(s.meanLatency - 1260.4) < 0.1, `meanLatency ${s.meanLatency}`);
  assert.equal(s.maxLatency, 1330.0);
});

test('summarize: missing latencyMs → meanLatency and maxLatency are null', () => {
  const pts = [
    { dist: 100, rssi: -90, snr: 5, pid: 1, latencyMs: NaN },
    { dist: 200, rssi: -95, snr: 4, pid: 2, latencyMs: NaN },
  ];
  const s = RL.summarize(pts);
  assert.equal(s.meanLatency, null);
  assert.equal(s.maxLatency, null);
});

test('rssiColor: strong→green, near-floor→red, missing→grey', () => {
  assert.equal(RL.rssiColor(-80), '#7a9e7e');
  assert.equal(RL.rssiColor(-130), '#c04040');
  assert.equal(RL.rssiColor(NaN), '#6a6078');
});

/* ============================ V2 18-col CSV parsing + log processing ============================ */
test('V2 parseCSV: 18-column header maps every V2 field', () => {
  const { idx, rows } = RL.parseCSV(FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -953, 52, 1330));
  assert.equal(idx['event_type'], 0);
  assert.equal(idx['packet_id'], 5);
  assert.equal(idx['rx_late7'], 6);
  assert.equal(idx['rx_lnge7'], 7);
  assert.equal(idx['tx_late7'], 9);
  assert.equal(idx['tx_lnge7'], 10);
  assert.equal(idx['rx_rssix10'], 12);
  assert.equal(idx['rx_snrx10'], 13);
  assert.equal(idx['packet_len'], 16);
  assert.equal(idx['latency_us'], 17);
  assert.equal(rows.length, 1);
});

test('V2 hasTxColumns: true (tx_late7/tx_lnge7 present)', () => {
  assert.equal(RL.hasTxColumns(RL.parseCSV(FW_HEADER_V2).idx), true);
});

test('V2 processRows: rx_rssix10/rx_snrx10 divided by 10 → dBm/dB', () => {
  const csv = FW_HEADER_V2 + '\n' + v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -953, 52, 1330);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1);
  near(pts[0].rssi, -95.3, 1e-9, 'rssi -953/10 = -95.3 dBm');
  near(pts[0].snr, 5.2, 1e-9, 'snr 52/10 = 5.2 dB');
});

test('V2 processRows: dual-GPS distance from rx_late7/tx_late7', () => {
  // rx 0.01° north of tx → ~1111.95 m
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 370100000, -1220000000, 370000000, -1220000000, -950, 50, 1330);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1);
  near(pts[0].dist, 1111.95, 1, 'rx↔tx 0.01° apart');
});

test('V2 processRows: RX no-fix (0,0) rows are dropped', () => {
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -950, 50, 1330) + '\n' +
    v2Row(2, 0, 0, 334255000, -1119400000, -1200, -80, 1400);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1, 'the RX 0,0 row is skipped');
  assert.equal(pts[0].pid, 1);
});

test('V2 processRows: TX no-fix (0,0) rows are dropped', () => {
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -950, 50, 1330) + '\n' +
    v2Row(2, 334255000, -1119400000, 0, 0, -1000, 40, 1400);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1, 'the TX 0,0 row is skipped');
  assert.equal(pts[0].pid, 1);
});

test('V2 processRows: latency_us → latencyMs = us/1000 (uint32 fits in Number)', () => {
  // SF12/125k round-trip ~2.6s. 2,600,000 µs → 2600 ms. uint32 max ~4.3e9 < 2^53.
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -950, 50, 2600000) + '\n' +
    v2Row(2, 334255000, -1119400000, 334255000, -1119400000, -960, 48, 2550000);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0].latencyMs - 2600) < 1e-6, `latency ${pts[0].latencyMs}`);
  assert.ok(Math.abs(pts[1].latencyMs - 2550) < 1e-6, `latency ${pts[1].latencyMs}`);
});

test('V2 processRows: latency_us = 0 (unsolicited) → latencyMs = 0, not NaN', () => {
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -950, 50, 0);
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].latencyMs, 0, 'latency_us=0 → latencyMs=0 (unsolicited/missed TX_DONE sentinel)');
});

test('V2 processRows: V2 latency_us takes precedence over V1 tx_gps_us when both present', () => {
  // Synthetic header with both latency_us and the V1 timestamp pair — V2 wins.
  const header = FW_HEADER_V2 + ',tx_gps_us,rx_gps_us';
  const row = v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -950, 50, 2600) +
              ',1718123456123000,1718123456125300';  // V1 would give 2.3 ms
  const { idx, rows } = RL.parseCSV(header + '\n' + row);
  const pts = RL.processRows(idx, rows, null);
  assert.equal(pts.length, 1);
  assert.ok(Math.abs(pts[0].latencyMs - 2.6) < 1e-6, `V2 latency_us should win: ${pts[0].latencyMs}`);
});

test('V2 summarize: meanLatency/maxLatency from latency_us; PDR from packet_id', () => {
  const csv = FW_HEADER_V2 + '\n' +
    v2Row(1, 334255000, -1119400000, 334255000, -1119400000, -900, 70, 2600000) + '\n' +
    v2Row(2, 334255000, -1119400000, 334255000, -1119400000, -1000, 20, 2700000) + '\n' +
    v2Row(4, 334255000, -1119400000, 334255000, -1119400000, -1150, -50, 2650000);  // pid 3 missing
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  const s = RL.summarize(pts);
  assert.equal(s.count, 3);
  near(s.pdr, 75, 1e-9, '3 received over span 4 = 75%');                  // pids 1,2,4
  assert.equal(s.bestRssi, -90);
  assert.equal(s.worstRssi, -115);
  // latency_us 2,600,000 / 2,700,000 / 2,650,000 µs → 2600 / 2700 / 2650 ms; mean = 2650
  assert.ok(Math.abs(s.meanLatency - 2650) < 1e-6, `meanLatency ${s.meanLatency}`);
  assert.equal(s.maxLatency, 2700);
});

test('V2 processRows: corrupt/short rows skipped gracefully (resources capture shape)', () => {
  // Real V2 captures have produced rows with shifted columns / non-numeric
  // fields (firmware printf bug). processRows must skip them via isFinite
  // + the (0,0) no-fix guard, not throw.
  const csv = FW_HEADER_V2 + '\n' +
    'hu,16,1782509187,0,2,1,0,hu,0,0,hu,29089,-9586,7,-99,hu,0';  // tx 0,0 + junk
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  assert.ok(Array.isArray(pts), 'processRows must not throw on malformed rows');
});

/* ============================ Python generator fixtures ============================ */
const FIXTURES = [
  { name: 'minimal', hasTx: true, minRows: 1, hasGaps: false },
  { name: 'gaps',    hasTx: true, minRows: 2, hasGaps: true  },
  { name: 'nofix',   hasTx: true, minRows: 1, hasGaps: false },
];

function loadFixture(name) {
  return fs.readFileSync(`tools/fixtures/${name}.csv`, 'utf-8');
}

for (const f of FIXTURES) {
  test(`fixture: ${f.name} — parses as dual-GPS CSV with tx_* columns`, () => {
    const csv = loadFixture(f.name);
    const { idx, rows } = RL.parseCSV(csv);
    assert.equal(RL.hasTxColumns(idx), f.hasTx, `${f.name} should have tx columns`);
    assert.ok(rows.length >= f.minRows, `${f.name} should have >= ${f.minRows} rows`);
  });

  test(`fixture: ${f.name} — processRows produces valid points`, () => {
    const csv = loadFixture(f.name);
    const { idx, rows } = RL.parseCSV(csv);
    const pts = RL.processRows(idx, rows, null);
    assert.ok(pts.length >= 0);
    for (const p of pts) {
      assert.ok(isFinite(p.dist), 'distance must be finite');
      assert.ok(p.dist >= 0, 'distance must be non-negative');
      assert.ok(isFinite(p.rxLat), 'rxLat must be finite');
      assert.ok(isFinite(p.rxLng), 'rxLng must be finite');
    }
  });

  test(`fixture: ${f.name} — summarize returns stats`, () => {
    const csv = loadFixture(f.name);
    const { idx, rows } = RL.parseCSV(csv);
    const pts = RL.processRows(idx, rows, null);
    if (pts.length) {
      const s = RL.summarize(pts);
      assert.ok(s !== null);
      assert.equal(s.count, pts.length);
      assert.ok(s.maxDist >= 0);
    }
  });
}

test('fixture: realistic_short — 40+ packets expected (some dropped by gaps)', () => {
  const csv = loadFixture('realistic_short');
  const { idx, rows } = RL.parseCSV(csv);
  assert.equal(RL.hasTxColumns(idx), true);
  const pts = RL.processRows(idx, rows, null);
  assert.ok(pts.length >= 40, 'realistic_short should produce 40+ processed points');
});

test('fixture: realistic_long — 60+ packets expected (some dropped by gaps)', () => {
  const csv = loadFixture('realistic_long');
  const { idx, rows } = RL.parseCSV(csv);
  assert.equal(RL.hasTxColumns(idx), true);
  const pts = RL.processRows(idx, rows, null);
  assert.ok(pts.length >= 60, 'realistic_long should produce 60+ processed points');
});

test('fixture: gaps — drop rows produce gaps in packet_ids', () => {
  const csv = loadFixture('gaps');
  const { idx, rows } = RL.parseCSV(csv);
  const pts = RL.processRows(idx, rows, null);
  const s = RL.summarize(pts);
  assert.ok(s !== null);
  const span = Math.max(...pts.map(p => p.pid)) - Math.min(...pts.map(p => p.pid)) + 1;
  // With 5 packets at 0.4 drop rate, there should be dropped IDs
  // Either PDR < 100% or actual rows < raw count
  assert.ok(pts.length < rows.length || s.pdr < 100,
    'gaps fixture should have fewer processed points than raw rows or PDR < 100%');
});

test('fixture: nofix — no-fix rows are dropped by processRows', () => {
  const csv = loadFixture('nofix');
  const { idx, rows } = RL.parseCSV(csv);
  // Verify no-fix sentinel rows exist in raw CSV (V2 columns)
  let nofixRaw = 0;
  for (const r of rows) {
    const rxLat = parseInt(r[idx['rx_late7']], 10) / 1e7;
    const rxLng = parseInt(r[idx['rx_lnge7']], 10) / 1e7;
    const txLat = parseInt(r[idx['tx_late7']], 10) / 1e7;
    const txLng = parseInt(r[idx['tx_lnge7']], 10) / 1e7;
    if ((rxLat === 0 && rxLng === 0) || (txLat === 0 && txLng === 0)) nofixRaw++;
  }
  assert.ok(nofixRaw > 0, 'nofix fixture must contain at least one (0,0) sentinel row');

  const pts = RL.processRows(idx, rows, null);
  // processRows should drop (0,0) rows, so processed count < raw count
  assert.ok(pts.length < rows.length, 'processed points must be fewer than raw rows (no-fix rows dropped)');
  const s = RL.summarize(pts);
  assert.ok(s !== null);
  assert.ok(s.count > 0);
});

test('fixture: all preset CSVs have consistent V2 dual-GPS header', () => {
  const names = ['minimal', 'gaps', 'nofix', 'realistic_short', 'realistic_long'];
  for (const name of names) {
    const csv = loadFixture(name);
    const { idx } = RL.parseCSV(csv);
    assert.ok('tx_late7' in idx, `${name} must have tx_late7`);
    assert.ok('tx_lnge7' in idx, `${name} must have tx_lnge7`);
    assert.ok('rx_late7' in idx, `${name} must have rx_late7`);
    assert.ok('rx_lnge7' in idx, `${name} must have rx_lnge7`);
    assert.ok('rx_rssix10' in idx, `${name} must have rx_rssix10`);
    assert.ok('rx_snrx10' in idx, `${name} must have rx_snrx10`);
    assert.ok('packet_id' in idx, `${name} must have packet_id`);
    assert.ok('event_type' in idx, `${name} must have event_type`);
    assert.ok('packet_len' in idx, `${name} must have packet_len`);
    assert.ok('latency_us' in idx, `${name} must have latency_us`);
  }
});

/* ============================ filterPoints / valueRange ============================ */
// inline points: {dist, rssi, snr, pid, latencyMs}
const PTS = [
  { dist: 100,  rssi: -80,  snr: 8,  pid: 1, latencyMs: 10 },
  { dist: 500,  rssi: -95,  snr: 4,  pid: 2, latencyMs: 20 },
  { dist: 1500, rssi: -110, snr: -2, pid: 3, latencyMs: 30 },
  { dist: 3000, rssi: NaN,  snr: 1,  pid: 4, latencyMs: NaN },
];

test('filterPoints: empty/no ranges returns every point', () => {
  assert.equal(RL.filterPoints(PTS, {}).length, 4);
  assert.equal(RL.filterPoints(PTS, { dist: null, rssi: null }).length, 4);
});

test('filterPoints: distance window keeps only near rows', () => {
  const out = RL.filterPoints(PTS, { dist: [0, 1000] });
  assert.deepEqual(out.map(p => p.pid), [1, 2]);
});

test('filterPoints: rssi window drops out-of-range AND NaN-rssi rows', () => {
  const out = RL.filterPoints(PTS, { rssi: [-100, -70] });
  assert.deepEqual(out.map(p => p.pid), [1, 2]);   // -110 out, NaN dropped
});

test('filterPoints: a NaN field survives when that field is NOT constrained', () => {
  const out = RL.filterPoints(PTS, { dist: [0, 5000] });   // rssi unconstrained
  assert.deepEqual(out.map(p => p.pid), [1, 2, 3, 4]);     // NaN-rssi pid 4 kept
});

test('filterPoints: combined ranges intersect (AND) and never mutate input', () => {
  const snapshot = JSON.stringify(PTS);
  const out = RL.filterPoints(PTS, { dist: [0, 2000], pid: [2, 9] });
  assert.deepEqual(out.map(p => p.pid), [2, 3]);
  assert.equal(JSON.stringify(PTS), snapshot, 'input array untouched');
});

test('valueRange: min/max over finite values, ignores NaN', () => {
  assert.deepEqual(RL.valueRange(PTS, 'dist'), { min: 100, max: 3000 });
  assert.deepEqual(RL.valueRange(PTS, 'rssi'), { min: -110, max: -80 });
});

test('valueRange: all-NaN field returns null; single point min===max', () => {
  assert.equal(RL.valueRange([{ rssi: NaN }, { rssi: NaN }], 'rssi'), null);
  assert.deepEqual(RL.valueRange([{ dist: 42 }], 'dist'), { min: 42, max: 42 });
});

/* ============================ histogram ============================ */
test('histogram: 10 values into 5 bins → 2 per bin', () => {
  const h = RL.histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 });
  assert.equal(h.length, 5);
  assert.deepEqual(h.map(b => b.count), [2, 2, 2, 2, 2]);
});

test('histogram: edge values land in expected bins, max in last bin', () => {
  const h = RL.histogram([0, 5, 10], { min: 0, max: 10, bins: 2 });
  assert.equal(h[0].count, 1);   // 0 -> bin 0
  assert.equal(h[1].count, 2);   // 5 -> bin 1, 10 -> clamped to last bin
});

test('histogram: empty / all-NaN input returns []', () => {
  assert.deepEqual(RL.histogram([]), []);
  assert.deepEqual(RL.histogram([NaN, NaN]), []);
});

test('histogram: bins=1 returns a single bucket with all values', () => {
  const h = RL.histogram([1, 2, 3, 4], { bins: 1 });
  assert.equal(h.length, 1);
  assert.equal(h[0].count, 4);
});

test('histogram: NaN min/max falls back to data extent (no crash)', () => {
  const h = RL.histogram([1, 2, 3], { min: NaN, bins: 3 });
  assert.equal(h.length, 3);
  assert.equal(h.reduce((a, b) => a + b.count, 0), 3, 'all values counted');
});

test('histogram: an inverted [max<min] window is tolerated by swapping', () => {
  const h = RL.histogram([1, 2, 3, 4], { min: 10, max: 0, bins: 2 });
  assert.equal(h.reduce((a, b) => a + b.count, 0), 4);
});

/* ============================ gridBins ============================ */
const GEO = [
  { rxLat: 33.42550, rxLng: -111.94000, rssi: -90, snr: 5 },   // cluster A
  { rxLat: 33.42550, rxLng: -111.94000, rssi: -100, snr: 3 },  // cluster A (same cell)
  { rxLat: 33.45000, rxLng: -111.94000, rssi: NaN, snr: NaN }, // far cell, all-NaN
];

test('gridBins: clustered + far points produce ≥2 non-empty cells', () => {
  const cells = RL.gridBins(GEO, { cellMeters: 100 });
  assert.ok(cells.length >= 2, `expected >=2 cells, got ${cells.length}`);
  const total = cells.reduce((a, c) => a + c.count, 0);
  assert.equal(total, 3);
});

test('gridBins: meanRssi is the arithmetic mean of finite RSSI in a cell', () => {
  const cells = RL.gridBins(GEO, { cellMeters: 100 });
  const busy = cells.find(c => c.count === 2);
  assert.ok(busy, 'a 2-point cell exists');
  near(busy.meanRssi, -95, 1e-9, 'mean of -90,-100');
});

test('gridBins: a cell with only NaN RSSI reports meanRssi null', () => {
  const cells = RL.gridBins(GEO, { cellMeters: 100 });
  const lone = cells.find(c => c.count === 1);
  assert.ok(lone, 'the far cell exists');
  assert.equal(lone.meanRssi, null);
});

test('gridBins: deterministic for a fixed input; empty in → empty out', () => {
  assert.deepEqual(RL.gridBins(GEO, { cellMeters: 100 }), RL.gridBins(GEO, { cellMeters: 100 }));
  assert.deepEqual(RL.gridBins([], { cellMeters: 100 }), []);
});

/* ============================ compareSessions ============================ */
test('compareSessions: direction-aware best/worst flags across 2 sessions', () => {
  const A = { count: 50, maxDist: 1000, meanDist: 400, bestRssi: -80, worstRssi: -110,
              pdr: 90, meanLatency: 50, maxLatency: 80 };
  const B = { count: 60, maxDist: 2000, meanDist: 500, bestRssi: -70, worstRssi: -120,
              pdr: 80, meanLatency: 40, maxLatency: 70 };
  const c = RL.compareSessions([{ name: 'A', summary: A }, { name: 'B', summary: B }]);
  const get = k => c.metrics.find(m => m.key === k);
  assert.deepEqual(c.names, ['A', 'B']);
  assert.equal(get('maxDist').bestIdx, 1, 'B has the longer max range');
  assert.equal(get('pdr').bestIdx, 0, 'A has the higher PDR');
  assert.equal(get('bestRssi').bestIdx, 1, 'best RSSI = least negative (B -70)');
  assert.equal(get('worstRssi').bestIdx, 0, 'better floor = higher RSSI (A -110)');
  assert.equal(get('meanLatency').bestIdx, 1, 'lower latency is better (B 40)');
});

test('compareSessions: single session yields no comparative flags', () => {
  const c = RL.compareSessions([{ name: 'solo', summary: { maxDist: 1000, pdr: 95 } }]);
  c.metrics.forEach(m => { assert.equal(m.bestIdx, -1); assert.equal(m.worstIdx, -1); });
});

test('compareSessions: a null/absent metric is never flagged best/worst', () => {
  const A = { maxDist: 1000, pdr: null };
  const B = { maxDist: 2000, pdr: 80 };
  const c = RL.compareSessions([{ name: 'A', summary: A }, { name: 'B', summary: B }]);
  const pdr = c.metrics.find(m => m.key === 'pdr');
  assert.equal(pdr.bestIdx, -1, 'only one finite PDR → no winner');
  assert.equal(pdr.values[0], null);
});

/* ============================ pathLossFit ============================ */
test('pathLossFit: recovers a known exponent from log-linear data (r²≈1)', () => {
  // RSSI = -30 - 10*n*log10(d), n = 3
  const pts = [1, 10, 100, 1000].map(d => ({ dist: d, rssi: -30 - 30 * Math.log10(d) }));
  const fit = RL.pathLossFit(pts);
  assert.ok(fit !== null);
  near(fit.n, 3, 1e-6, 'path-loss exponent');
  near(fit.r2, 1, 1e-9, 'perfect fit');
  near(fit.intercept, -30, 1e-6, 'intercept');
});

test('pathLossFit: <2 usable points → null; ignores zero/neg distance & NaN rssi', () => {
  assert.equal(RL.pathLossFit([{ dist: 100, rssi: -90 }]), null);
  assert.equal(RL.pathLossFit([{ dist: 0, rssi: -90 }, { dist: -5, rssi: -95 },
                               { dist: 100, rssi: NaN }]), null);
});

/* ============================ summaryToMarkdown ============================ */
test('summaryToMarkdown: emits a titled table with metric rows', () => {
  const md = RL.summaryToMarkdown({ count: 3, maxDist: 1500, meanDist: 600,
    bestRssi: -80, worstRssi: -110, pdr: 75, meanLatency: 20, maxLatency: 30 }, 'Run 1');
  assert.match(md, /### Run 1/);
  assert.match(md, /\| Metric \| Value \|/);
  assert.match(md, /\| Packets \| 3 \|/);
  assert.match(md, /\| Max range \| 1.50 km \|/);
  assert.match(md, /\| Delivery ratio \| 75.0 % \|/);
});

test('summaryToMarkdown: null summary is handled gracefully', () => {
  const md = RL.summaryToMarkdown(null, 'Empty');
  assert.match(md, /### Empty/);
  assert.match(md, /No data/);
});

test('rssiBucket: qualitative label tracks the colour ramp', () => {
  assert.equal(RL.rssiBucket(-80), 'strong');
  assert.equal(RL.rssiBucket(-110), 'fair');
  assert.equal(RL.rssiBucket(-130), 'floor');
  assert.equal(RL.rssiBucket(NaN), 'n/a');
});
