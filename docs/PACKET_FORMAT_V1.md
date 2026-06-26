# Packet & Log Format

This document describes the wire and log formats used by the sftrk LoRa range-testing tool. The two formats are:

1. **Beacon payload** — what the TX node sends over the air
2. **RX CSV row** — what the logger node writes to its SD card

Both are designed to be self-describing and minimal. The CSV row is the primary input to the browser-based log processor (`range-testing.html`).

---

## 1. Beacon payload (TX → air)

The TX node broadcasts a fixed-layout 22-byte struct on every beacon. Fields are little-endian, packed in this order:

```c
struct Beacon {           // 22 bytes total
  uint8_t  node_id;       // 1 byte  — sender's hardware node ID
  uint32_t packet_id;     // 4 bytes — monotonic, for loss detection
  int32_t  lat_e7;        // 4 bytes — TX latitude  × 1e7
  int32_t  lng_e7;        // 4 bytes — TX longitude × 1e7
  uint64_t tx_gps_us;     // 8 bytes — TX GPS-synced Unix time, microseconds
  uint8_t  flags;         // 1 byte  — fix-valid, sats bucket, ...
};
```

### Field details

| Field | Type | Bytes | Meaning | Unit |
|---|---|---|---|---|
| `node_id` | uint8 | 1 | Sender's hardware node ID (0–255) | — |
| `packet_id` | uint32 | 4 | Monotonically increasing packet counter, wraps at 2^32 | — |
| `lat_e7` | int32 | 4 | TX latitude × 10^7 (≈1.1 cm resolution) | degrees × 1e7 |
| `lng_e7` | int32 | 4 | TX longitude × 10^7 (≈1.1 cm resolution) | degrees × 1e7 |
| `tx_gps_us` | uint64 | 8 | TX GPS-synced Unix time at transmit (see §3) | µs since Unix epoch |
| `flags` | uint8 | 1 | Bitfield: bit 0 = fix-valid, bits 1–3 = sat count bucket | — |

### Time-on-air impact

The 22-byte payload is larger than the original 14-byte design. At default config SF12 / 125 kHz / CR 4/5:

- 14 B → ~1220 ms airtime
- 22 B → ~1330 ms airtime (~9% increase)

At SF7 the absolute increase is small (~56 → ~62 ms). For the default range-testing cadence (1 beacon/second) the overhead is acceptable.

---

## 2. RX CSV row (logger → SD)

The RX node writes one CSV row per received packet. The header line is:

```
time_valid,utc_iso,event_type,node_id,packet_id,lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db,tx_lat_e7,tx_lng_e7,tx_gps_us,rx_gps_us
```

### Field details

| Field | Type | Unit | Nullable? | Example | Notes |
|---|---|---|---|---|---|
| `time_valid` | uint8 | bool | no | `1` | 1 = RX clock GPS-PPS-disciplined at event time |
| `utc_iso` | string | ISO 8601 | no | `2026-06-17T16:38:24Z` | Human-readable UTC timestamp |
| `event_type` | uint8 | enum | no | `2` | 1 = TX event, 2 = RX event (firmware-defined) |
| `node_id` | uint8 | — | no | `1` | The TX node's ID (from beacon payload) |
| `packet_id` | uint32 | — | no | `42` | Monotonic packet counter (from beacon payload) |
| `lat_e7` | int32 | degrees × 1e7 | yes* | `334255000` | RX latitude (local GPS); `(0,0)` = no fix |
| `lng_e7` | int32 | degrees × 1e7 | yes* | `-1119400000` | RX longitude (local GPS); `(0,0)` = no fix |
| `gps_fix_time_us` | uint64 | µs (local) | no | `0` | Local `micros()` when RX GPS fix was last sampled |
| `rssi_dbm` | float | dBm | no | `-95.3` | Received signal strength indicator |
| `snr_db` | float | dB | no | `5.2` | Signal-to-noise ratio |
| `tx_lat_e7` | int32 | degrees × 1e7 | yes* | `334255000` | TX latitude (from beacon); `(0,0)` = TX no fix |
| `tx_lng_e7` | int32 | degrees × 1e7 | yes* | `-1119400000` | TX longitude (from beacon); `(0,0)` = TX no fix |
| `tx_gps_us` | uint64 | µs (Unix) | yes** | `1718123456123456` | TX GPS-synced Unix time at transmit |
| `rx_gps_us` | uint64 | µs (Unix) | yes** | `1718123456124678` | RX GPS-synced Unix time at receive |

\* Rows with `lat_e7=0,lng_e7=0` (RX no-fix) or `tx_lat_e7=0,tx_lng_e7=0` (TX no-fix) are **dropped** by the parser (`range-lib.js` §`processRows`).

\** Old logs (pre-GPS-PPS firmware) will have empty `tx_gps_us`/`rx_gps_us` columns. The parser handles missing columns gracefully — latency is `NaN` in that case and the UI displays `—`.

### Latency (computed, not stored)

Latency is **not** a CSV column — it is computed at log-processor time:

```
latency_ms = (rx_gps_us - tx_gps_us) / 1000
```

This is computed in JavaScript using `BigInt` for exact integer arithmetic (safe for any realistic Unix-µs magnitude — see §3).

### Backward compatibility

The parser (`range-lib.js:processRows`) uses `pickCol()` to look up columns by name and returns `-1` if absent. This means:

- Old CSVs without `tx_gps_us`/`rx_gps_us` still parse — those points just have `latencyMs: NaN`
- The legacy single-GPS format (no `tx_*` columns) still works via the reference-point fallback
- Adding columns is non-breaking; removing them is

---

## 3. GPS-PPS timing model

Both nodes have GPS modules with **PPS (pulse-per-second)** outputs disciplining their microsecond clocks. This gives both nodes a common time reference accurate to < 1 µs after the PPS edge.

### How `tx_gps_us` is produced (TX node)

1. The TX node's GPS module receives NMEA `$GPRMC` sentences containing UTC date/time (resolution: 1 second)
2. On each PPS rising edge, the MCU captures a `micros()` reading — this is the "fractional µs since the last UTC second boundary"
3. At transmit time (just before the SX1262 TX FIFO load), the MCU reads its `micros()` and computes:
   ```
   tx_gps_us = (gps_unix_sec * 1000000) + (current_micros - last_pps_micros)
   ```
4. This `uint64_t` is packed into the beacon payload (see §1)

### How `rx_gps_us` is produced (RX node)

1. The RX node maintains the same PPS-disciplined clock
2. At the SX1262 DIO1 "RX done" ISR (`onRadioDio1()` in `src/main.cpp`), the MCU captures its current `micros()`
3. After the ISR returns and the packet is read, the log handler computes:
   ```
   rx_gps_us = (gps_unix_sec * 1000000) + (current_micros - last_pps_micros)
   ```
4. This `uint64_t` is written to the CSV as the `rx_gps_us` column

### Why `uint64_t` Unix microseconds

- **Standard**: Unix epoch is the universal time format (same as `Date.now()` in JS, `time.time()` in Python, `System.currentTimeMillis()` in Java)
- **Precision**: µs precision captures the full PPS-disciplined clock accuracy
- **Size**: `uint64_t` is 8 bytes — fits in the beacon payload with no compression
- **MCU-friendly**: No float math on the embedded side; `printf("%llu")` handles it natively
- **JS-safe**: `parseInt("1718123456123456")` is exact up to 2^53 ≈ 9.0×10^15 (year 2255). At 2026 the value is ~1.78×10^15, well under the limit

### Latency definition

```
latency_ms = (rx_gps_us - tx_gps_us) / 1000
```

This is computed in `range-lib.js` using `BigInt` to avoid floating-point precision loss:

```js
const diff = BigInt(rx_gps_us) - BigInt(tx_gps_us);
const latencyMs = Number(diff) / 1000;
```

**Why BigInt:** the operands are large integers (~1.78×10^15), but the *difference* is small (~1.2×10^6 µs for 1.2 s of airtime). IEEE 754 doubles have ~0.25 µs ULP at the operand magnitude, so `(rx - tx)` in regular Number arithmetic is exact to ~0.25 µs — already safe. BigInt removes any doubt and is correct for any future magnitude.

### What latency includes

| Component | Typical | Notes |
|---|---|---|
| **Airtime** | 50–1300 ms | Dominant. Set by SF/BW/CR/payload (Semtech formula) |
| **Modem processing** | 1–5 ms | SX1262 internal handling after DIO1 IRQ |
| **Software latency** | 0.5–3 ms | ISR → readData → log handler |
| **Clock residual skew** | < 1 µs | PPS discipline error |
| **Total** | ≈ airtime + 1–10 ms | "Latency" ≈ measured time-on-air |

For a static SF/BW config, latency should be **roughly constant** across all packets. Variation comes from:
- PPS jitter (sub-µs, negligible)
- Software scheduling jitter (a few ms)
- Interference-induced retransmissions (firmware does not retransmit, but the SX1262 can hold the packet in its buffer)

---

## 4. Reference

- **Semtech SX1262 datasheet** — Table 3-8 (RX sensitivity), §6 (LoRa airtime)
- **TinyGPS++** — NMEA `$GPRMC` parsing for UTC date/time
- **`range-lib.js`** — `parseCSV()`, `processRows()`, `summarize()`, `timeOnAir()`
- **`tools/gen_csv.py`** — Python mirror of the Semtech airtime formula for test data generation
