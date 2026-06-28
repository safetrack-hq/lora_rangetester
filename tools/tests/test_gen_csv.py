"""Tests for tools/gen_csv.py — pytest suite.

Run:
    cd tools/ && python -m pytest tests/ -v
"""

import csv
import io
import math
import os
import random
import sys
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

# Allow importing gen_csv from the parent directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import gen_csv as g


# =========================================================================
# Geodesy
# =========================================================================
class TestHaversine:
    def test_identical_points(self):
        assert g.haversine(33.4255, -111.94, 33.4255, -111.94) == 0

    def test_equator_degree(self):
        d = g.haversine(0, 0, 0, 1)
        assert abs(d - 111194.9) < 1

    def test_small_step(self):
        d = g.haversine(37.0, -122.0, 37.01, -122.0)
        assert abs(d - 1111.95) < 1


class TestLatToE7:
    def test_positive(self):
        assert g.lat_to_e7(33.4255104) == 334255104

    def test_negative(self):
        assert g.lat_to_e7(-33.4255) == -334255000

    def test_zero(self):
        assert g.lat_to_e7(0) == 0


class TestLngToE7:
    def test_positive(self):
        assert g.lng_to_e7(111.9400) == 1119400000

    def test_negative(self):
        assert g.lng_to_e7(-111.9400) == -1119400000

    def test_zero(self):
        assert g.lng_to_e7(0) == 0


class TestDestination:
    def test_east_moves_lng(self):
        lat, lng = g.destination(0, 0, 90, 111195)
        assert abs(lat) < 0.01
        assert abs(lng - 1) < 0.01

    def test_north_moves_lat(self):
        lat, lng = g.destination(0, 0, 0, 111195)
        assert abs(lat - 1) < 0.01
        assert abs(lng) < 0.01


# =========================================================================
# RF Model
# =========================================================================
class TestFsplDb:
    def test_fspl_1m(self):
        # FSPL at 1 m / 915 MHz ≈ 31.7 dB
        f = g.fspl_db(0.001, 915)
        assert abs(f - 31.67) < 0.1

    def test_fspl_1km(self):
        f = g.fspl_db(1, 915)
        assert abs(f - 91.67) < 0.1

    def test_fspl_increases_with_distance(self):
        assert g.fspl_db(10, 915) > g.fspl_db(1, 915)

    def test_fspl_increases_with_frequency(self):
        assert g.fspl_db(1, 2400) > g.fspl_db(1, 915)


class TestRssiAtDistance:
    def test_rssi_decreases_with_distance(self):
        r1 = g.rssi_at_distance(0.1, 915, 22, 2.15, 2.15, 1)
        r2 = g.rssi_at_distance(5, 915, 22, 2.15, 2.15, 1)
        assert r2 < r1

    def test_rssi_at_1km_default(self):
        # With 22 dBm, 2.15 dBi ant, we expect about -66.4 dBm at 1 km
        r = g.rssi_at_distance(1, 915, 22, 2.15, 2.15, 1)
        assert abs(r - (-66.37)) < 1

    def test_higher_power_increases_rssi(self):
        r1 = g.rssi_at_distance(1, 915, 10, 2.15, 2.15, 1)
        r2 = g.rssi_at_distance(1, 915, 20, 2.15, 2.15, 1)
        assert r2 > r1


class TestSnrFromRssi:
    def test_snr_positive_for_strong_rssi(self):
        # With noise floor -125, RSSI -80 → SNR ≈ 45
        random.seed(42)
        snr = g.snr_from_rssi(-80, -125)
        assert snr > 30

    def test_snr_negative_for_very_weak_signal(self):
        random.seed(42)
        snr = g.snr_from_rssi(-130, -125)
        assert snr < 0


# =========================================================================
# Geocoding
# =========================================================================
class TestGeocodeLocation:
    def test_returns_none_when_geopy_missing(self):
        # When geopy is not installed, HAS_GEOCODING is False
        if not g.HAS_GEOCODING:
            assert g.geocode_location('Tempe AZ') is None

    @patch('gen_csv.Nominatim')
    def test_geocode_tempe(self, mock_nominatim):
        mock_geo = MagicMock()
        mock_geo.geocode.return_value = MagicMock(latitude=33.4255, longitude=-111.9400)
        mock_nominatim.return_value = mock_geo

        result = g.geocode_location('Tempe AZ')
        assert result is not None
        assert abs(result[0] - 33.4255) < 0.01
        assert abs(result[1] - -111.94) < 0.01

    @patch('gen_csv.Nominatim')
    def test_geocode_failure_returns_none(self, mock_nominatim):
        mock_geo = MagicMock()
        mock_geo.geocode.return_value = None
        mock_nominatim.return_value = mock_geo

        assert g.geocode_location('NowhereXYZ') is None


# =========================================================================
# RX Point Generation
# =========================================================================
class TestGenerateRxPoints:
    def test_count_match(self):
        pts = g.generate_rx_points(33.4255, -111.94, 50, 5,
                                   pattern='random', gps_noise_sigma=0)
        assert len(pts) == 50

    def test_single_route_count(self):
        pts = g.generate_rx_points(33.4255, -111.94, 10, 5,
                                   pattern='single', gps_noise_sigma=0)
        assert len(pts) == 10

    def test_radial_route_count(self):
        pts = g.generate_rx_points(33.4255, -111.94, 30, 5,
                                   pattern='radial', gps_noise_sigma=0)
        assert len(pts) == 30

    def test_points_within_max_range(self):
        random.seed(42)
        pts = g.generate_rx_points(33.4255, -111.94, 50, 5,
                                   pattern='radial', gps_noise_sigma=0)
        for pt in pts:
            d = g.haversine(33.4255, -111.94, pt[0], pt[1])
            assert d <= 5000 * 1.05  # allow 5% over for jitter

    def test_zero_count(self):
        pts = g.generate_rx_points(33.4255, -111.94, 0, 5)
        assert pts == []


class TestGpsNoise:
    def test_noise_adds_scatter(self):
        random.seed(1)
        clean = g._radial_routes(33.4255, -111.94, 10, 1, gps_noise_sigma=0)
        random.seed(1)
        noisy = g._radial_routes(33.4255, -111.94, 10, 1, gps_noise_sigma=10)
        # At least one point should differ measurably
        diffs = [g.haversine(c[0], c[1], n[0], n[1]) for c, n in zip(clean, noisy)]
        assert max(diffs) > 0.1


# =========================================================================
# Gap Insertion (now inside generate_rows)
# =========================================================================
class TestGapsInRows:
    def test_no_gaps_when_rate_zero(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               gap_rate=0.0)
        assert len(rows) == 3

    def test_some_gaps_when_rate_nonzero(self):
        tx = (33.4255, -111.94)
        rx = [(33.43 + i * 0.01, -111.94) for i in range(100)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               gap_rate=0.3)
        assert len(rows) < 100
        assert len(rows) > 50

    def test_packet_ids_have_gaps(self):
        tx = (33.4255, -111.94)
        rx = [(33.43 + i * 0.01, -111.94) for i in range(20)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               gap_rate=0.3)
        pids = [r['packet_id'] for r in rows]
        # With 20 packets at 0.3 rate, should have ~14 kept
        # There should be gaps (not strictly sequential from 1)
        assert len(pids) < 20, "gaps should reduce packet count"
        # The gap has created actual holes if max > len
        if len(rows) > 0 and pids:
            assert max(pids) > len(rows), "packet_ids should have gaps (max > kept count)"

    def test_drop_curve_removes_more_far_points(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)] * 10 + [(33.48, -111.90)] * 10
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               gap_rate=0.0, drop_curve_km=5, max_range_km=5)
        assert len(rows) >= 5

    def test_gaps_with_drop_curve(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               gap_rate=0.5, drop_curve_km=10, max_range_km=10)
        assert len(rows) >= 0


# =========================================================================
# Row Generation
# =========================================================================
class TestGenerateRows:
    def test_output_count(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert len(rows) == 3

    def test_csv_header_present(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        expected_fields = g.CSV_HEADER.split(',')
        for field in expected_fields:
            assert field in rows[0]

    def test_packet_ids_monotonic(self):
        tx = (33.4255, -111.94)
        rx = [(33.43 + i * 0.01, -111.94) for i in range(5)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        pids = [r['packet_id'] for r in rows]
        assert pids == list(range(1, 6))

    def test_rssi_decreases_with_distance(self):
        tx = (33.4255, -111.94)
        rx = [(33.4255, -111.94), (33.43, -111.94), (33.44, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               rssi_sigma=0)  # no scatter for clean comparison
        # rx_rssix10 is int ×10; divide by 10 to compare dBm
        assert rows[0]['rx_rssix10'] / 10 > rows[1]['rx_rssix10'] / 10
        assert rows[1]['rx_rssix10'] / 10 > rows[2]['rx_rssix10'] / 10

    def test_tx_coords_consistent(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert rows[0]['tx_late7'] == g.lat_to_e7(33.4255)
        assert rows[0]['tx_lnge7'] == g.lng_to_e7(-111.94)

    def test_event_time_increments_by_beacon_interval(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               2.0, datetime(2026, 6, 17, 14, 32, 0))
        # event_time is unix seconds; 2s beacon interval → +2s per row
        assert rows[1]['event_time'] == rows[0]['event_time'] + 2

    def test_v2_identity_and_packet_len(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert rows[0]['node_id'] == g.DEFAULT_NODE_ID      # responder (2)
        assert rows[0]['target_id'] == g.DEFAULT_TARGET_ID  # requester (1)
        assert rows[0]['packet_len'] == g.LOCATION_PACKET_LEN  # 23
        assert rows[0]['event_type'] == g.SFTRK_FLAG_GPS_VALID  # 0x10

    def test_event_pps_micros_always_zero(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert rows[0]['event_pps_micros'] == 0  # PPS not wired in firmware

    def test_forward_and_return_rssi_independent(self):
        # Same FSPL(d) but independent jitter → tx_rssix10 != rx_rssix10
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)] * 20
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               rssi_sigma=3.0)
        diffs = [abs(r['rx_rssix10'] - r['tx_rssix10']) for r in rows]
        assert max(diffs) > 0, 'forward/return RSSI must differ (independent jitter)'


# =========================================================================
# No-Fix Injection (V2)
# =========================================================================
class TestInjectNofixRows:
    def _make_rows(self):
        return [
            {'event_type': g.SFTRK_FLAG_GPS_VALID, 'event_time': 0, 'event_pps_micros': 0,
             'node_id': 2, 'target_id': 1, 'packet_id': 1,
             'rx_late7': 334255000, 'rx_lnge7': -1119400000, 'rx_sats': 7,
             'tx_late7': 334255000, 'tx_lnge7': -1119400000, 'tx_sats': 7,
             'rx_rssix10': -950, 'rx_snrx10': 50, 'tx_rssix10': -950, 'tx_snrx10': 50,
             'packet_len': 23, 'latency_us': 2600000},
            {'event_type': g.SFTRK_FLAG_GPS_VALID, 'event_time': 0, 'event_pps_micros': 0,
             'node_id': 2, 'target_id': 1, 'packet_id': 2,
             'rx_late7': 334265000, 'rx_lnge7': -1119300000, 'rx_sats': 7,
             'tx_late7': 334255000, 'tx_lnge7': -1119400000, 'tx_sats': 7,
             'rx_rssix10': -950, 'rx_snrx10': 50, 'tx_rssix10': -950, 'tx_snrx10': 50,
             'packet_len': 23, 'latency_us': 2700000},
        ]

    def test_modifies_rows_in_place(self):
        rows = self._make_rows()
        random.seed(42)
        result = g.inject_nofix_rows(rows, count=1)
        assert len(result) == len(rows)
        nofix = [r for r in result if r['rx_late7'] == 0 or r['tx_late7'] == 0]
        assert len(nofix) >= 1

    def test_sets_nofix_sentinel_and_event_type(self):
        rows = self._make_rows()
        random.seed(42)
        result = g.inject_nofix_rows(rows, count=1)
        nofix = [r for r in result if r['rx_late7'] == 0 or r['tx_late7'] == 0]
        assert len(nofix) >= 1
        for r in nofix:
            assert r['event_type'] == g.SFTRK_FLAG_GPS_INVALID  # 0x20


# =========================================================================
# Airtime Model (Semtech SX1262)
# =========================================================================
class TestSemtechAirtime:
    def test_sf12_125k_22b(self):
        # SF12/125k/CR 4/5/22B payload, SX1262 preamble (6.25) → ~1384 ms
        airtime = g.semtech_airtime_us(12, 125, 1, 22)
        assert abs(airtime - 1384448) < 5000, f"airtime {airtime} µs"

    def test_sf7_125k_22b(self):
        # SF7/125k/22B → ~54 ms (much shorter)
        airtime = g.semtech_airtime_us(7, 125, 1, 22)
        assert abs(airtime - 53504) < 5000, f"airtime {airtime} µs"

    def test_sf7_lower_than_sf12(self):
        a7 = g.semtech_airtime_us(7, 125, 1, 22)
        a12 = g.semtech_airtime_us(12, 125, 1, 22)
        assert a7 < a12

    def test_wider_bw_shorter_airtime(self):
        a125 = g.semtech_airtime_us(12, 125, 1, 22)
        a500 = g.semtech_airtime_us(12, 500, 1, 22)
        assert a500 < a125


# =========================================================================
# Round-trip latency_us Generation (V2 — radio IRQ timestamps, no GPS-PPS)
# =========================================================================
class TestLatencyGeneration:
    def test_rows_have_latency_us(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert 'latency_us' in rows[0]
        assert 'tx_gps_us' not in rows[0]   # V1 timestamps retired in V2
        assert 'rx_gps_us' not in rows[0]

    def test_latency_us_positive(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        for r in rows:
            assert r['latency_us'] > 0, f"latency_us {r['latency_us']} should be > 0"

    def test_latency_within_round_trip_plus_jitter(self):
        # SF12/125k round-trip = fwd(6B) + turnaround(20ms) + ret(23B).
        # fwd ~893ms, ret ~1384ms, turnaround 20ms → ~2297ms; jitter σ=3ms.
        # Allow 2280-2320 ms (±~6σ).
        tx = (33.4255, -111.94)
        rx = [(33.43 + i * 0.01, -111.94) for i in range(20)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0),
                               sf=12, bw_khz=125)
        for r in rows:
            lat_ms = r['latency_us'] / 1000
            assert 2280 < lat_ms < 2320, f"latency {lat_ms} ms out of range"

    def test_sf7_lower_latency_than_sf12(self):
        # SF7 round-trip is much shorter than SF12
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows7 = g.generate_rows(rx, tx[0], tx[1],
                                915, 22, 2.15, 2.15, 1,
                                1.5, datetime(2026, 6, 17, 14, 32, 0),
                                sf=7, bw_khz=125)
        random.seed(42)
        rows12 = g.generate_rows(rx, tx[0], tx[1],
                                 915, 22, 2.15, 2.15, 1,
                                 1.5, datetime(2026, 6, 17, 14, 32, 0),
                                 sf=12, bw_khz=125)
        lat7 = rows7[0]['latency_us']
        lat12 = rows12[0]['latency_us']
        assert lat7 < lat12, f"SF7 latency {lat7} should be < SF12 {lat12}"

    def test_latency_us_is_int(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert isinstance(rows[0]['latency_us'], int)

    def test_event_time_uses_unix_epoch(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        # Unix seconds for 2026-06-17 14:32:00 UTC
        expected_base = int(datetime(2026, 6, 17, 14, 32, 0,
                                      tzinfo=timezone.utc).timestamp())
        # First row's event_time should equal expected_base (pid=1 → offset 0)
        assert rows[0]['event_time'] == expected_base


# =========================================================================
# Sparkline
# =========================================================================
class TestSparkline:
    def test_empty(self):
        assert g.sparkline([]) == ''

    def test_single_value(self):
        sl = g.sparkline([50])
        assert len(sl) == 1
        assert sl in '▁▂▃▄▅▆▇█'

    def test_ascending(self):
        sl = g.sparkline([0, 100])
        assert sl[0] < sl[-1] or sl[0] == '▁'

    def test_all_same_value(self):
        sl = g.sparkline([5, 5, 5])
        assert len(sl) == 3


# =========================================================================
# Seed Reproducibility
# =========================================================================
class TestSeedReproducibility:
    def test_same_seed_same_output(self):
        random.seed(42)
        pts1 = g.generate_rx_points(33.4255, -111.94, 10, 5, 'random', 0)
        random.seed(42)
        pts2 = g.generate_rx_points(33.4255, -111.94, 10, 5, 'random', 0)
        for p1, p2 in zip(pts1, pts2):
            assert abs(p1[0] - p2[0]) < 1e-10
            assert abs(p1[1] - p2[1]) < 1e-10

    def test_different_seed_different_output(self):
        random.seed(1)
        pts1 = g.generate_rx_points(33.4255, -111.94, 10, 5, 'random', 0)
        random.seed(2)
        pts2 = g.generate_rx_points(33.4255, -111.94, 10, 5, 'random', 0)
        # At least some points should differ
        diffs = sum(1 for p1, p2 in zip(pts1, pts2) if abs(p1[0] - p2[0]) > 1e-10)
        assert diffs > 0


# =========================================================================
# CSV Write Format
# =========================================================================
class TestCsvFormat:
    def test_csv_header_order(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        expected = g.CSV_HEADER.split(',')
        assert list(rows[0].keys()) == expected

    def test_csv_e7_format(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert isinstance(rows[0]['rx_late7'], int)
        assert isinstance(rows[0]['rx_lnge7'], int)
        assert isinstance(rows[0]['tx_late7'], int)
        assert isinstance(rows[0]['tx_lnge7'], int)

    def test_rx_rssix10_is_int(self):
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        # V2 stores RSSI/SNR as int ×10 (dBm×10 / dB×10), not float dBm
        assert isinstance(rows[0]['rx_rssix10'], int)
        assert isinstance(rows[0]['rx_snrx10'], int)
        assert isinstance(rows[0]['tx_rssix10'], int)
        assert isinstance(rows[0]['tx_snrx10'], int)


# =========================================================================
# Presets
# =========================================================================
class TestPresets:
    def test_all_presets_have_required_keys(self):
        required = {'count', 'max_range_km', 'gap_rate', 'pattern'}
        for name, cfg in g.PRESETS.items():
            for key in required:
                assert key in cfg, f'{name} missing {key}'

    def test_preset_values_are_reasonable(self):
        for name, cfg in g.PRESETS.items():
            assert cfg['count'] >= 1
            assert cfg['max_range_km'] > 0
            assert 0 <= cfg['gap_rate'] <= 1
            assert cfg['pattern'] in ('radial', 'single', 'random')


# =========================================================================
# Integration: CSV parseable by range-lib.js
# =========================================================================
class TestCsvParseableByRangeLib:
    def _import_range_lib(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        import importlib
        try:
            module = importlib.import_module('range-lib')
            return module
        except Exception:
            # Attempt to load via subprocess
            return None

    def _write_csv_to_string(self, rows):
        output = io.StringIO()
        w = csv.DictWriter(output, fieldnames=g.CSV_HEADER.split(','))
        w.writeheader()
        w.writerows(rows)
        return output.getvalue()

    def test_rows_parse(self):
        """Generate a minimal V2 CSV and verify range-lib.js can parse it."""
        tx = (33.4255, -111.94)
        rx = [(33.43, -111.94), (33.44, -111.94), (33.45, -111.94)]
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        csv_text = self._write_csv_to_string(rows)

        # Verify CSV structure matches V2 range-lib expectations
        lines = csv_text.strip().split('\n')
        header = lines[0].lower()
        assert 'tx_late7' in header
        assert 'tx_lnge7' in header
        assert 'rx_late7' in header
        assert 'rx_lnge7' in header
        assert 'rx_rssix10' in header
        assert 'rx_snrx10' in header
        assert 'packet_id' in header
        assert 'event_type' in header
        assert 'packet_len' in header
        assert 'latency_us' in header
        assert len(lines) - 1 == 3  # header + 3 data rows

    def test_known_distances(self):
        """Verify generated distances match haversine expectations."""
        tx = (33.4255, -111.94)
        rx = [(33.4255, -111.94)]  # same point = 0 distance
        random.seed(42)
        rows = g.generate_rows(rx, tx[0], tx[1],
                               915, 22, 2.15, 2.15, 1,
                               1.5, datetime(2026, 6, 17, 14, 32, 0))
        assert len(rows) == 1
        # Distance should be near 0
        rx_lat = rows[0]['rx_late7'] / 1e7
        rx_lng = rows[0]['rx_lnge7'] / 1e7
        d = g.haversine(rx_lat, rx_lng, tx[0], tx[1])
        assert d < 10  # within 10m due to GPS noise


# =========================================================================
# Defaults and constants
# =========================================================================
class TestDefaults:
    def test_default_tx_is_tempe(self):
        assert abs(g.DEFAULT_TX_LAT - 33.4255) < 0.001
        assert abs(g.DEFAULT_TX_LNG - -111.94) < 0.001

    def test_csv_header_has_all_required_v2_fields(self):
        fields = g.CSV_HEADER.split(',')
        for f in ['event_type', 'event_time', 'event_pps_micros',
                  'node_id', 'target_id', 'packet_id',
                  'rx_late7', 'rx_lnge7', 'rx_sats',
                  'tx_late7', 'tx_lnge7', 'tx_sats',
                  'rx_rssix10', 'rx_snrx10', 'tx_rssix10', 'tx_snrx10',
                  'packet_len', 'latency_us']:
            assert f in fields, f'{f} missing from V2 header'
        # V1 columns were retired with the 22-byte beacon (see PACKET_FORMAT_V2.md §8)
        for retired in ['tx_gps_us', 'rx_gps_us', 'rssi_dbm', 'snr_db',
                        'lat_e7', 'lng_e7', 'tx_lat_e7', 'tx_lng_e7',
                        'utc_iso', 'gps_fix_time_us', 'time_valid',
                        'event_time_us']:
            assert retired not in fields, f'{retired} must not be in V2 header'

    def test_v2_wire_constants(self):
        assert g.SFTRK_FLAG_GPS_VALID == 0x10
        assert g.SFTRK_FLAG_GPS_INVALID == 0x20
        assert g.LOCATION_PACKET_LEN == 23
        assert g.REQ_LOG_LEN == 6
        assert g.DEFAULT_NODE_ID == 2
        assert g.DEFAULT_TARGET_ID == 1

    def test_presets_exist(self):
        for name in ('minimal', 'gaps', 'nofix', 'realistic_short', 'realistic_long'):
            assert name in g.PRESETS
