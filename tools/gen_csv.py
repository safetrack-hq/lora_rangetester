#!/usr/bin/env python3
"""sftrk CSV Generator — generates dual-GPS CSV files for LoRa range testing.

Usage:
  python tools/gen_csv.py --interactive          Interactive mode
  python tools/gen_csv.py --preset realistic_short  Preset scenario
  python tools/gen_csv.py --tx-lat 33.42 --tx-lng -111.94 --count 50  Direct flags
  python tools/gen_csv.py --help                 Full help
"""

import csv
import math
import os
import random
import sys
import textwrap
from datetime import datetime, timedelta

import click

try:
    from geopy.geocoders import Nominatim
    HAS_GEOCODING = True
except ImportError:
    HAS_GEOCODING = False


# ── Constants ──────────────────────────────────────────────────────────
EARTH_R = 6371008.8
NOISE_FLOOR_DEFAULT = -125.0
TX_POWER_DEFAULT = 22.0
GAIN_DEFAULT = 2.15
CABLE_LOSS_DEFAULT = 1.0
FREQ_DEFAULT = 915.0
BEACON_INTERVAL_DEFAULT = 1.5

DEFAULT_TX_LAT = 33.4255
DEFAULT_TX_LNG = -111.9400

PRESETS = {
    'minimal': {
        'count': 3, 'max_range_km': 1.0, 'gap_rate': 0.0,
        'pattern': 'single', 'seed': 42,
    },
    'gaps': {
        'count': 5, 'max_range_km': 2.0, 'gap_rate': 0.4,
        'pattern': 'single', 'seed': 42,
    },
    'nofix': {
        'count': 4, 'max_range_km': 2.0, 'gap_rate': 0.0,
        'pattern': 'single', 'seed': 42,
    },
    'realistic_short': {
        'count': 50, 'max_range_km': 2.0, 'gap_rate': 0.1,
        'pattern': 'radial', 'seed': None,
    },
    'realistic_long': {
        'count': 80, 'max_range_km': 8.0, 'gap_rate': 0.15,
        'pattern': 'radial', 'seed': None,
    },
}

SPARKLINE_CHARS = '▁▂▃▄▅▆▇█'
CSV_HEADER = (
    'event_time_us,time_valid,utc_iso,event_type,node_id,packet_id,'
    'lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db,tx_lat_e7,tx_lng_e7'
)


# ── Geodesy ───────────────────────────────────────────────────────────
def haversine(lat1, lng1, lat2, lng2):
    rad = math.pi / 180
    p1 = lat1 * rad
    p2 = lat2 * rad
    dp = (lat2 - lat1) * rad
    dl = (lng2 - lng1) * rad
    a = (math.sin(dp / 2) ** 2 +
         math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1, math.sqrt(a)))


def destination(lat, lng, brg_deg, dist_m):
    rad = math.pi / 180
    R = EARTH_R
    brg = math.radians(brg_deg)
    d = dist_m / R
    lat1 = math.radians(lat)
    lng1 = math.radians(lng)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(d) +
        math.cos(lat1) * math.sin(d) * math.cos(brg)
    )
    lng2 = lng1 + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2)
    )
    return (math.degrees(lat2), math.degrees(lng2))


def lat_to_e7(lat):
    return round(lat * 1e7)


def lng_to_e7(lng):
    return round(lng * 1e7)


# ── Geocoding ──────────────────────────────────────────────────────────
def geocode_location(query, user_agent="sftrk-csv-gen"):
    if not HAS_GEOCODING:
        return None
    try:
        geolocator = Nominatim(user_agent=user_agent)
        loc = geolocator.geocode(query)
        if loc:
            return (loc.latitude, loc.longitude)
    except Exception:
        pass
    return None


# ── RF Model ──────────────────────────────────────────────────────────
def fspl_db(d_km, f_mhz):
    return 32.44 + 20 * math.log10(f_mhz) + 20 * math.log10(max(d_km, 1e-6))


def rssi_at_distance(d_km, f_mhz, ptx, gt, gr, loss):
    return ptx + gt + gr - loss - fspl_db(d_km, f_mhz)


def snr_from_rssi(rssi_dbm, noise_floor, sigma=2.0):
    return rssi_dbm - noise_floor + random.gauss(0, sigma)


# ── RX Point Generation ──────────────────────────────────────────────
def generate_rx_points(tx_lat, tx_lng, count, max_range_km,
                       pattern='radial', gps_noise_sigma=3.0):
    if pattern == 'random':
        return _random_scatter(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma)
    elif pattern == 'single':
        return _single_route(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma)
    else:
        return _radial_routes(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma)


def _jitter(pt, gps_noise_sigma, ref_lat):
    lat = pt[0] + random.gauss(0, gps_noise_sigma / 111320)
    lng = pt[1] + random.gauss(0, gps_noise_sigma / (111320 * math.cos(math.radians(ref_lat))))
    return (lat, lng)


def _random_scatter(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma):
    max_range_m = max_range_km * 1000
    pts = []
    for _ in range(count):
        angle = random.uniform(0, 360)
        dist = random.uniform(0, max_range_m)
        pt = destination(tx_lat, tx_lng, angle, dist)
        pts.append(_jitter(pt, gps_noise_sigma, tx_lat))
    return pts


def _single_route(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma):
    max_range_m = max_range_km * 1000
    angle = random.uniform(0, 360)
    pts = []
    for i in range(count):
        frac = (i + 1) / count
        dist = frac * max_range_m
        lateral = random.gauss(0, dist * 0.05) if i > 0 else 0
        eff_angle = angle + lateral / (dist + 1) * 50
        pt = destination(tx_lat, tx_lng, eff_angle, min(dist, max_range_m))
        pts.append(_jitter(pt, gps_noise_sigma, tx_lat))
    return pts


def _radial_routes(tx_lat, tx_lng, count, max_range_km, gps_noise_sigma):
    max_range_m = max_range_km * 1000
    n_routes = random.randint(3, 5)
    route_angles = [random.uniform(0, 360) for _ in range(n_routes)]
    per_route = [count // n_routes] * n_routes
    for i in range(count % n_routes):
        per_route[i] += 1

    pts = []
    for ri in range(n_routes):
        angle = route_angles[ri]
        n_pts = per_route[ri]
        for i in range(n_pts):
            frac = (i + 1) / n_pts
            dist = frac * max_range_m * random.uniform(0.85, 1.0)
            lateral = 0
            if i > 0:
                lateral = random.gauss(0, dist * 0.08)
            eff_angle = angle + lateral / (dist + 1) * 60
            if i > n_pts // 2 and random.random() < 0.15:
                frac_back = random.uniform(0.3, 0.7)
                dist = frac_back * max_range_m
                eff_angle = (angle + 180 + random.uniform(-30, 30)) % 360
            pt = destination(tx_lat, tx_lng, eff_angle, min(dist, max_range_m))
            pts.append(_jitter(pt, gps_noise_sigma, tx_lat))

    random.shuffle(pts)
    return pts


# ── Gap Insertion ─────────────────────────────────────────────────────
def insert_gaps(rx_points, gap_rate, drop_curve_km=None, max_range_km=None,
                tx_lat=None, tx_lng=None):
    kept = []
    for pt in rx_points:
        if drop_curve_km and max_range_km and max_range_km > 0 and tx_lat is not None:
            dist_m = haversine(pt[0], pt[1], tx_lat, tx_lng)
            dist_km = dist_m / 1000
            threshold = drop_curve_km * 0.5
            if dist_km > threshold:
                t = (dist_km - threshold) / (drop_curve_km - threshold + 1e-6)
                local_rate = 0.1 + 0.9 * min(t, 1.0)
                if random.random() < local_rate:
                    continue
            else:
                if random.random() < gap_rate:
                    continue
        else:
            if random.random() < gap_rate:
                continue
        kept.append(pt)
    return kept


# ── Row Generation ───────────────────────────────────────────────────
def generate_rows(rx_points, tx_lat, tx_lng, f_mhz, ptx, gt, gr, loss,
                  beacon_interval, start_utc, rssi_sigma=3.0, snr_sigma=2.0,
                  noise_floor=NOISE_FLOOR_DEFAULT):
    rows = []
    pid = 1
    time_us = 0
    dt = start_utc

    for (rx_lat, rx_lng) in rx_points:
        dist_m = haversine(tx_lat, tx_lng, rx_lat, rx_lng)
        d_km = dist_m / 1000

        if d_km > 0:
            rssi = rssi_at_distance(d_km, f_mhz, ptx, gt, gr, loss)
            rssi += random.gauss(0, rssi_sigma)
        else:
            rssi = -30 + random.gauss(0, rssi_sigma)

        snr = snr_from_rssi(rssi, noise_floor, snr_sigma)

        rows.append({
            'event_time_us': time_us,
            'time_valid': 1,
            'utc_iso': dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'event_type': 2,
            'node_id': 1,
            'packet_id': pid,
            'lat_e7': lat_to_e7(rx_lat),
            'lng_e7': lng_to_e7(rx_lng),
            'gps_fix_time_us': time_us,
            'rssi_dbm': round(rssi, 1),
            'snr_db': round(snr, 1),
            'tx_lat_e7': lat_to_e7(tx_lat),
            'tx_lng_e7': lng_to_e7(tx_lng),
        })

        pid += 1
        time_us += int(beacon_interval * 1e6)
        dt += timedelta(seconds=beacon_interval)

    return rows


def inject_nofix_rows(rows, count=1):
    if not rows:
        return rows
    nofix_indices = random.sample(range(len(rows)), min(count, len(rows)))
    for idx in sorted(nofix_indices, reverse=True):
        is_tx = random.random() < 0.5
        r = dict(rows[idx])
        if is_tx:
            r['tx_lat_e7'] = 0
            r['tx_lng_e7'] = 0
        else:
            r['lat_e7'] = 0
            r['lng_e7'] = 0
        rows.insert(idx + 1, r)
    return rows


# ── Sparkline ─────────────────────────────────────────────────────────
def sparkline(values):
    if not values:
        return ''
    mn, mx = min(values), max(values)
    span = mx - mn
    if span == 0:
        return SPARKLINE_CHARS[len(SPARKLINE_CHARS) // 2] * min(len(values), 40)
    nb = len(SPARKLINE_CHARS)
    norm = [(v - mn) / span for v in values]
    return ''.join(SPARKLINE_CHARS[min(int(v * nb), nb - 1)] for v in norm)


# ── ASCII Map ─────────────────────────────────────────────────────────
def ascii_map(tx_lat, tx_lng, rx_points, width=40, height=14):
    if not rx_points:
        return '(no points to map)'

    lats = [tx_lat] + [p[0] for p in rx_points]
    lngs = [tx_lng] + [p[1] for p in rx_points]
    lat_min, lat_max = min(lats), max(lats)
    lng_min, lng_max = min(lngs), max(lngs)
    lat_span = lat_max - lat_min
    lng_span = lng_max - lng_min

    if lat_span == 0 and lng_span == 0:
        return '(all points at same location)'

    pad = 0.1
    lat_min -= lat_span * pad if lat_span > 0 else 0.001
    lat_max += lat_span * pad if lat_span > 0 else 0.001
    lng_min -= lng_span * pad if lng_span > 0 else 0.001
    lng_max += lng_span * pad if lng_span > 0 else 0.001
    lat_span = lat_max - lat_min
    lng_span = lng_max - lng_min

    aspect = lat_span / lng_span if lng_span > 0 else 1
    h = max(int(width * aspect * 0.5), 5)
    h = min(h, height * 2)

    grid = [[' ' for _ in range(width)] for _ in range(h)]

    def to_grid(lat, lng, char):
        x = int((lng - lng_min) / lng_span * (width - 1)) if lng_span > 0 else 0
        y = int((lat_max - lat) / lat_span * (h - 1)) if lat_span > 0 else 0
        x = max(0, min(x, width - 1))
        y = max(0, min(y, h - 1))
        grid[y][x] = char

    to_grid(tx_lat, tx_lng, '⊕')
    for pt in rx_points:
        if grid[max(0, min(int((lat_max - pt[0]) / lat_span * (h - 1)) if lat_span > 0 else 0, h - 1))] \
               [max(0, min(int((pt[1] - lng_min) / lng_span * (width - 1)) if lng_span > 0 else 0, width - 1))] != '⊕':
            pass
        to_grid(pt[0], pt[1], '·')

    lines = [''.join(row) for row in grid]
    return '\n'.join(lines)


# ── CSV Output ────────────────────────────────────────────────────────
def write_csv(rows, path):
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=CSV_HEADER.split(','))
        w.writeheader()
        w.writerows(rows)


# ── Preset Loader ─────────────────────────────────────────────────────
def load_preset(name, tx_lat, tx_lng):
    p = PRESETS.get(name)
    if not p:
        return None
    cfg = dict(p)
    cfg['tx_lat'] = tx_lat
    cfg['tx_lng'] = tx_lng
    return cfg


# ── Default Output Filename ──────────────────────────────────────────
def default_outpath(count, tx_lat, tx_lng):
    now = datetime.now().strftime('%Y%m%d')
    return f'range_tempe_{count}pkts_{now}.csv'


# ── CLI ───────────────────────────────────────────────────────────────
@click.command(context_settings=dict(help_option_names=['-h', '--help']))
@click.option('--interactive', is_flag=True, help='Walk through prompts interactively')
@click.option('--preset', type=click.Choice(list(PRESETS.keys())), default=None,
              help='Use a preset scenario (ignores most flags)')
@click.option('--tx-lat', type=float, default=None, help='TX latitude')
@click.option('--tx-lng', type=float, default=None, help='TX longitude')
@click.option('--location', type=str, default=None,
              help='TX city / location name (geocoded, overrides --tx-lat/--tx-lng)')
@click.option('--count', type=int, default=None, help='Number of packets')
@click.option('--max-range', type=float, default=None, help='Max range in km')
@click.option('--pattern', type=click.Choice(['radial', 'single', 'random']), default=None,
              help='RX point distribution pattern')
@click.option('--gap-rate', type=float, default=None, help='Packet loss rate (0.0–1.0)')
@click.option('--drop-curve', type=float, default=None,
              help='Distance (km) where PDR starts falling linearly to near zero')
@click.option('--tx-power', type=float, default=None, help='TX power in dBm')
@click.option('--tx-gain', type=float, default=None, help='TX antenna gain in dBi')
@click.option('--rx-gain', type=float, default=None, help='RX antenna gain in dBi')
@click.option('--cable-loss', type=float, default=None, help='Cable loss in dB')
@click.option('--freq', type=float, default=None, help='Frequency in MHz')
@click.option('--gps-noise', type=float, default=None, help='GPS noise sigma (m)')
@click.option('--rssi-sigma', type=float, default=None, help='RSSI scatter sigma (dB)')
@click.option('--snr-sigma', type=float, default=None, help='SNR scatter sigma (dB)')
@click.option('--beacon', type=float, default=None, help='Beacon interval (s)')
@click.option('--nofix', type=int, default=0, help='Number of no-fix sentinel rows to inject')
@click.option('--start-utc', type=str, default=None,
              help='Start datetime (YYYY-MM-DDTHH:MM:SS)')
@click.option('--out', type=str, default=None, help='Output CSV path')
@click.option('--seed', type=int, default=None, help='Random seed for reproducibility')
@click.option('--no-summary', is_flag=True, help='Suppress terminal summary')
def cli(**kwargs):
    _main(**kwargs)


def _main(interactive, preset, tx_lat, tx_lng, location, count, max_range,
          pattern, gap_rate, drop_curve, tx_power, tx_gain, rx_gain,
          cable_loss, freq, gps_noise, rssi_sigma, snr_sigma,
          beacon, nofix, start_utc, out, seed, no_summary):

    cfg = {}

    # ── Resolve preset ────────────────────────────────────────────────
    if preset:
        p = PRESETS[preset]
        cfg['count'] = p['count']
        cfg['max_range_km'] = p['max_range_km']
        cfg['gap_rate'] = p['gap_rate']
        cfg['pattern'] = p['pattern']
        if p.get('seed') is not None:
            cfg['seed'] = p['seed']

    # ── Interactive mode ──────────────────────────────────────────────
    if interactive:
        click.echo('')
        click.echo('  ┌────────────────────────────────────┐')
        click.echo('  │  sftrk CSV Generator               │')
        click.echo('  │  LoRa Range Test Data              │')
        click.echo('  └────────────────────────────────────┘')
        click.echo('')

        default_loc = f'{DEFAULT_TX_LAT}, {DEFAULT_TX_LNG}'
        loc_str = click.prompt('  TX lat/lng (or city name)', default=default_loc,
                               show_default=True)
        loc_str = loc_str.strip()

        lat_val, lng_val = None, None
        try:
            parts = [p.strip() for p in loc_str.replace(',', ' ').split()]
            if len(parts) >= 2:
                try:
                    lat_val = float(parts[0])
                    lng_val = float(parts[1])
                except ValueError:
                    pass
        except Exception:
            pass

        if lat_val is None:
            click.echo('  → Geocoding location...')
            geo = geocode_location(loc_str)
            if geo:
                lat_val, lng_val = geo
                click.echo(f'  → Resolved: {lat_val:.4f}, {lng_val:.4f}')
            else:
                click.echo('  → Geocoding failed, using Tempe AZ default')
                lat_val, lng_val = DEFAULT_TX_LAT, DEFAULT_TX_LNG

        cfg['tx_lat'] = lat_val
        cfg['tx_lng'] = lng_val

        cfg['pattern'] = click.prompt('  Pattern (radial/single/random)',
                                      default=cfg.get('pattern', 'radial'),
                                      show_default=True,
                                      type=click.Choice(['radial', 'single', 'random']))
        cfg['max_range_km'] = click.prompt('  Max range (km)',
                                           default=cfg.get('max_range_km', 5.0),
                                           show_default=True, type=float)
        cfg['count'] = click.prompt('  Packet count',
                                    default=cfg.get('count', 50),
                                    show_default=True, type=int)

        click.echo('  ── RF Parameters (optional) ──')
        cfg['tx_power'] = click.prompt('  TX power (dBm)',
                                       default=cfg.get('tx_power', TX_POWER_DEFAULT),
                                       show_default=True, type=float)
        cfg['tx_gain'] = click.prompt('  TX antenna gain (dBi)',
                                      default=cfg.get('tx_gain', GAIN_DEFAULT),
                                      show_default=True, type=float)
        cfg['rx_gain'] = click.prompt('  RX antenna gain (dBi)',
                                      default=cfg.get('rx_gain', GAIN_DEFAULT),
                                      show_default=True, type=float)
        cfg['cable_loss'] = click.prompt('  Cable loss (dB)',
                                         default=cfg.get('cable_loss', CABLE_LOSS_DEFAULT),
                                         show_default=True, type=float)
        cfg['freq'] = click.prompt('  Frequency (MHz)',
                                   default=cfg.get('freq', FREQ_DEFAULT),
                                   show_default=True, type=float)

        click.echo('  ── Loss & Noise ──')
        cfg['gap_rate'] = click.prompt('  Gap/loss rate (0.0–1.0)',
                                       default=cfg.get('gap_rate', 0.1),
                                       show_default=True, type=float)
        dc_input = click.prompt('  Drop curve distance in km (blank=off)',
                                default='', show_default=False)
        cfg['drop_curve'] = float(dc_input) if dc_input.strip() else None
        cfg['gps_noise'] = click.prompt('  GPS noise sigma (m)',
                                        default=cfg.get('gps_noise', 3.0),
                                        show_default=True, type=float)
        cfg['rssi_sigma'] = click.prompt('  RSSI scatter sigma (dB)',
                                         default=cfg.get('rssi_sigma', 3.0),
                                         show_default=True, type=float)
        cfg['snr_sigma'] = click.prompt('  SNR scatter sigma (dB)',
                                        default=cfg.get('snr_sigma', 2.0),
                                        show_default=True, type=float)

        click.echo('  ── Timing ──')
        cfg['beacon'] = click.prompt('  Beacon interval (s)',
                                     default=cfg.get('beacon', BEACON_INTERVAL_DEFAULT),
                                     show_default=True, type=float)
        start_default = datetime.now().strftime('%Y-%m-%d %H:%M')
        st = click.prompt('  Start UTC (YYYY-MM-DD HH:MM)',
                          default=start_default, show_default=True)
        try:
            cfg['start_utc'] = datetime.strptime(st, '%Y-%m-%d %H:%M')
        except ValueError:
            cfg['start_utc'] = datetime.utcnow()

        cfg['nofix'] = click.prompt('  No-fix sentinel rows to inject',
                                    default=cfg.get('nofix', 0),
                                    show_default=True, type=int)

        click.echo('  ── Output ──')
        default_fn = default_outpath(cfg['count'], cfg['tx_lat'], cfg['tx_lng'])
        cfg['out'] = click.prompt('  Output filename',
                                  default=default_fn, show_default=True)
        seed_str = click.prompt('  Seed (blank=random)', default='', show_default=False)
        cfg['seed'] = int(seed_str) if seed_str.strip() else None

    else:
        # ── Direct flags / preset ─────────────────────────────────────
        if location:
            click.echo('→ Geocoding location...')
            geo = geocode_location(location)
            if geo:
                cfg['tx_lat'], cfg['tx_lng'] = geo
                click.echo(f'→ Resolved: {cfg["tx_lat"]:.4f}, {cfg["tx_lng"]:.4f}')
            else:
                click.echo('→ Geocoding failed, using Tempe AZ')
                cfg['tx_lat'], cfg['tx_lng'] = DEFAULT_TX_LAT, DEFAULT_TX_LNG
        else:
            cfg['tx_lat'] = tx_lat if tx_lat is not None else DEFAULT_TX_LAT
            cfg['tx_lng'] = tx_lng if tx_lng is not None else DEFAULT_TX_LNG

        for key, attr in [
            ('count', 'count'), ('max_range_km', 'max_range'),
            ('pattern', 'pattern'), ('gap_rate', 'gap_rate'),
            ('drop_curve', 'drop_curve'), ('tx_power', 'tx_power'),
            ('tx_gain', 'tx_gain'), ('rx_gain', 'rx_gain'),
            ('cable_loss', 'cable_loss'), ('freq', 'freq'),
            ('gps_noise', 'gps_noise'), ('rssi_sigma', 'rssi_sigma'),
            ('snr_sigma', 'snr_sigma'), ('beacon', 'beacon'),
            ('nofix', 'nofix'), ('seed', 'seed'),
        ]:
            val = kwargs.get(attr)
            if val is not None:
                cfg[key] = val

        if out:
            cfg['out'] = out

        if start_utc:
            try:
                cfg['start_utc'] = datetime.strptime(start_utc, '%Y-%m-%dT%H:%M:%S')
            except ValueError:
                cfg['start_utc'] = datetime.utcnow()

    # ── Fill defaults for anything still missing ──────────────────────
    cfg.setdefault('tx_lat', DEFAULT_TX_LAT)
    cfg.setdefault('tx_lng', DEFAULT_TX_LNG)
    cfg.setdefault('count', 50)
    cfg.setdefault('max_range_km', 5.0)
    cfg.setdefault('pattern', 'radial')
    cfg.setdefault('gap_rate', 0.1)
    cfg.setdefault('drop_curve', None)
    cfg.setdefault('tx_power', TX_POWER_DEFAULT)
    cfg.setdefault('tx_gain', GAIN_DEFAULT)
    cfg.setdefault('rx_gain', GAIN_DEFAULT)
    cfg.setdefault('cable_loss', CABLE_LOSS_DEFAULT)
    cfg.setdefault('freq', FREQ_DEFAULT)
    cfg.setdefault('gps_noise', 3.0)
    cfg.setdefault('rssi_sigma', 3.0)
    cfg.setdefault('snr_sigma', 2.0)
    cfg.setdefault('beacon', BEACON_INTERVAL_DEFAULT)
    cfg.setdefault('nofix', 0)
    cfg.setdefault('start_utc', datetime.utcnow())
    cfg.setdefault('out', default_outpath(cfg['count'], cfg['tx_lat'], cfg['tx_lng']))
    cfg.setdefault('no_summary', no_summary)
    if cfg.get('seed') is not None:
        random.seed(cfg['seed'])

    # ── Generate ──────────────────────────────────────────────────────
    rx_points = generate_rx_points(
        cfg['tx_lat'], cfg['tx_lng'],
        cfg['count'] + cfg['nofix'],
        cfg['max_range_km'],
        pattern=cfg['pattern'],
        gps_noise_sigma=cfg['gps_noise']
    )

    rx_points = insert_gaps(
        rx_points, cfg['gap_rate'], cfg['drop_curve'],
        cfg['max_range_km'], cfg['tx_lat'], cfg['tx_lng']
    )

    rows = generate_rows(
        rx_points,
        cfg['tx_lat'], cfg['tx_lng'],
        cfg['freq'], cfg['tx_power'], cfg['tx_gain'],
        cfg['rx_gain'], cfg['cable_loss'],
        cfg['beacon'], cfg['start_utc'],
        rssi_sigma=cfg['rssi_sigma'],
        snr_sigma=cfg['snr_sigma']
    )

    if cfg['nofix'] > 0 and rows:
        rows = inject_nofix_rows(rows, cfg['nofix'])

    write_csv(rows, cfg['out'])

    # ── Summary ───────────────────────────────────────────────────────
    if not cfg['no_summary']:
        _print_summary(rows, cfg)

    click.echo(f'✓ Written to {cfg["out"]}')


def _print_summary(rows, cfg):
    if not rows:
        click.echo('(no rows generated)')
        return

    pids = [r['packet_id'] for r in rows]
    rssis = [r['rssi_dbm'] for r in rows if r['rssi_dbm'] != '']
    snrs = [r['snr_db'] for r in rows if r['snr_db'] != '']

    span = max(pids) - min(pids) + 1
    pdr = len(rows) / span * 100 if span > 0 else 0

    # Compute distances for summary
    dists_m = []
    for r in rows:
        rx_lat = r['lat_e7'] / 1e7
        rx_lng = r['lng_e7'] / 1e7
        tx_lat = r['tx_lat_e7'] / 1e7
        tx_lng = r['tx_lng_e7'] / 1e7
        if rx_lat == 0 and rx_lng == 0:
            continue
        if tx_lat == 0 and tx_lng == 0:
            continue
        dists_m.append(haversine(rx_lat, rx_lng, tx_lat, tx_lng))

    max_dist_km = max(dists_m) / 1000 if dists_m else 0
    mean_dist_km = (sum(dists_m) / len(dists_m) / 1000) if dists_m else 0

    # Sparklines
    rssi_spark = sparkline(rssis) if rssis else ''
    snr_spark = sparkline(snrs) if snrs else ''

    click.echo('')
    click.echo('  ── Summary ─────────────────────────────────')
    click.echo(f'  Packets:  {len(rows)} logged, {span - len(rows)} lost ({pdr:.1f}% PDR)')
    if rssis:
        click.echo(f'  RSSI:     {min(rssis):.1f} → {max(rssis):.1f} dBm  {rssi_spark}')
    if snrs:
        click.echo(f'  SNR:      {min(snrs):.1f} → {max(snrs):.1f} dB   {snr_spark}')
    click.echo(f'  Max range: {max_dist_km:.2f} km')
    click.echo(f'  Mean dist: {mean_dist_km:.2f} km')

    # ASCII map
    rx_locs = []
    for r in rows:
        rx_lat = r['lat_e7'] / 1e7
        rx_lng = r['lng_e7'] / 1e7
        if rx_lat != 0 or rx_lng != 0:
            rx_locs.append((rx_lat, rx_lng))

    if rx_locs:
        click.echo('')
        ascii_lines = ascii_map(cfg['tx_lat'], cfg['tx_lng'], rx_locs)
        for line in ascii_lines.split('\n'):
            click.echo(f'  {line}')
    click.echo('')


# ── Entry Point ───────────────────────────────────────────────────────
if __name__ == '__main__':
    cli()
