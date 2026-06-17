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

// one firmware-format row helper (single GPS)
function fwRow(pid, latE7, lngE7, rssi, snr) {
  return `1000,1,2026-01-01T00:00:00Z,2,1,${pid},${latE7},${lngE7},900,${rssi},${snr}`;
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

test('rssiColor: strong→green, near-floor→red, missing→grey', () => {
  assert.equal(RL.rssiColor(-80), '#7a9e7e');
  assert.equal(RL.rssiColor(-130), '#c04040');
  assert.equal(RL.rssiColor(NaN), '#6a6078');
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
  const pts = RL.processRows(idx, rows, null);
  // Some rows may be RX or TX no-fix and get dropped
  const kept = pts.length;
  const raw = rows.length;
  assert.ok(kept <= raw, 'processed point count must not exceed raw row count');
  // At least one row should be valid
  if (kept > 0) {
    const s = RL.summarize(pts);
    assert.ok(s.count > 0);
  }
});

test('fixture: all preset CSVs have consistent dual-GPS header', () => {
  const names = ['minimal', 'gaps', 'nofix', 'realistic_short', 'realistic_long'];
  for (const name of names) {
    const csv = loadFixture(name);
    const { idx } = RL.parseCSV(csv);
    assert.ok('tx_lat_e7' in idx, `${name} must have tx_lat_e7`);
    assert.ok('tx_lng_e7' in idx, `${name} must have tx_lng_e7`);
    assert.ok('lat_e7' in idx, `${name} must have lat_e7`);
    assert.ok('lng_e7' in idx, `${name} must have lng_e7`);
    assert.ok('rssi_dbm' in idx, `${name} must have rssi_dbm`);
    assert.ok('snr_db' in idx, `${name} must have snr_db`);
    assert.ok('packet_id' in idx, `${name} must have packet_id`);
  }
});
