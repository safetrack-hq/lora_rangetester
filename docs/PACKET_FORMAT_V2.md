# Packet & Log Format V2

Supersedes `PACKET_FORMAT_V1.md` (kept for history; describes the retired 22-byte `Beacon` struct and 14-column CSV). This document describes the **actual current protocol** as implemented in `include/pkt.h`, `src/main.cpp` (nicenano/logger), and `tx_test/main.cpp` (beacon/responder).

---

## 1. Node roles

| Role | Firmware env | `NODE_ID` | Behavior |
|---|---|---|---|
| **Requester / Logger** | `nicenano` | 1 | On button press, sends `REQ_LOG`; on receiving a `LocationPacket`, writes one CSV row to SD. |
| **Responder / Beacon** | `tx_test` | 2 | Continuously in RX. On receiving a `REQ_LOG` addressed to it, replies with a `LocationPacket` carrying its current GPS fix. |

`NODE_ID` / `TARGET_ID` are compile-time (`platformio.ini` build_flags). The responder only acts on packets whose `targetId` matches its `NODE_ID`.

---

## 2. Wire packet structs

All structs are `__attribute__((packed))`, little-endian on nRF52 (ARM). Magic byte `0x56` (`SFTRK_MAGIC`) identifies sftrk packets on-air.

### 2a. `Header` — 6 bytes, prefix of every packet

| Offset | Field | Type | Bytes | Meaning |
|---|---|---|---|---|
| 0 | `magic` | uint8 | 1 | Always `0x56` |
| 1 | `flag` | uint8 | 1 | `sftrk_flag_t` value (see §3) |
| 2 | `nodeId` | uint16 | 2 | Sender's node ID |
| 4 | `targetId` | uint16 | 2 | Intended recipient's node ID |

### 2b. `AckPacket` — 6 bytes (Header only)

Used for both `SFTRK_FLAG_REQ_LOG` (0x30) and `SFTRK_FLAG_ACK` (0x40). No payload beyond the header. The requester's `REQ_LOG` is an `AckPacket` with `flag = 0x30`, `nodeId = requester`, `targetId = responder`.

### 2c. `LocationPacket` — 23 bytes

Sent responder → requester. Carries the responder's GPS fix plus the RSSI/SNR it measured when receiving the `REQ_LOG`.

| Offset | Field | Type | Bytes | Unit / scaling | Meaning |
|---|---|---|---|---|---|
| 0 | `header.magic` | uint8 | 1 | — | `0x56` |
| 1 | `header.flag` | uint8 | 1 | enum | `0x10` (GPS_VALID) or `0x20` (GPS_INVALID) |
| 2 | `header.nodeId` | uint16 | 2 | — | Responder node ID |
| 4 | `header.targetId` | uint16 | 2 | — | Requester node ID |
| 6 | `rx_rssi` | int16 | 2 | dBm × 10 | RSSI the **responder** measured on the `REQ_LOG` (forward path) |
| 8 | `rx_snr` | int16 | 2 | dB × 10 | SNR the **responder** measured on the `REQ_LOG` |
| 10 | `gps_fix` | bool | 1 | — | Responder's fix state at transmit |
| 11 | `gps_lng` | int32 | 4 | deg × 1e7 | Responder longitude |
| 15 | `gps_lat` | int32 | 4 | deg × 1e7 | Responder latitude |
| 19 | `gps_numSat` | uint8 | 1 | — | Responder satellite count |
| 20 | `gps_avgGsvSnr` | uint8 | 1 | — | Reserved (currently 0) |
| 21 | `packet_id` | uint16 | 2 | — | Monotonic counter from responder |

### Note on `flag` field typing

`pkt.h` declares `flag` as `sftrk_flag_t` (an enum). Under `-fshort-enums` (used by the Arduino nRF52 build) the enum is 1 byte and the `static_assert(sizeof(Header)==6)` passes. Under host LSP/default flags the enum is 4 bytes and the assert fires — a host-tooling artifact, not a firmware bug. The on-wire type is effectively `uint8`.

---

## 3. Flag enum (`sftrk_flag_t`)

| Name | Value | Carried by | Meaning |
|---|---|---|---|
| `SFTRK_FLAG_NONE` | 0x00 | — | Unused |
| `SFTRK_FLAG_GPS_VALID` | 0x10 | `LocationPacket` | Responder has a GPS fix |
| `SFTRK_FLAG_GPS_INVALID` | 0x20 | `LocationPacket` | Responder has no GPS fix |
| `SFTRK_FLAG_REQ_LOG` | 0x30 | `AckPacket` | Requester asks responder to log a range sample |
| `SFTRK_FLAG_ACK` | 0x40 | `AckPacket` | Reserved (not currently sent) |
| `SFTRK_FLAG_INVALID` | 0xFF | — | Sentinel returned by `sftrk_validate_packet` on rejection |

Low nibble = protocol revision (0 = logging protocol).

---

## 4. Transaction flow

```
nicenano (NODE_ID=1)                        tx_test (NODE_ID=2)
---------------------                       ----------------------
[button pressed]
   |
   v
pollTx -> txReqQueue
   |
   v
lora_handleRx drains queue
   |
   v
startTransmit(AckPacket{
   flag=0x30 REQ_LOG,                       [RX] handleRxDone
   nodeId=1, targetId=2               ---->   validate magic/flag/len/targetId
})                                           match targetId==NODE_ID(2)
   [TX_DONE]                                  enqueue PongReq{rssi,snr}
   startReceive()                             txPongTask:
                                                snapshot latestFix
                                                sftrk_make_location(...)
                                                startTransmit(LocationPacket)
                                              [TX_DONE]
                                              startReceive()
                                         <----
   [RX] handleRxDone
   sftrk_validate_packet -> GPS_VALID/INVALID
   handle_location(loc, valid, rssi, snrX10)
     snapshot local latestFix (rx_* fields)
     copy loc->gps_* into tx_* fields
     enqueue LogEvent
   startReceive()
   |
   v
writeLogTask drains logQueue
   -> logWriteToCsv -> SD buffer
   -> periodic flush every 5 s
```

One button press → one `REQ_LOG` → one `LocationPacket` reply → one CSV row. No retransmission, no ACK of the LocationPacket.

---

## 5. CSV log format (V2)

Header line written to `N<id>_<seq>.csv` on SD:

```
event_type,event_time,event_pps_micros,node_id,target_id,packet_id,rx_late7,rx_lnge7,rx_sats,tx_late7,tx_lnge7,tx_sats,rx_rssix10,rx_snrx10,tx_rssix10,tx_snrx10,packet_len,latency_us
```

18 columns. One row per received `LocationPacket`.

### Field reference

| # | Column | C type | Unit | Source | Wired? |
|---|---|---|---|---|---|
| 1 | `event_type` | uint8 | enum | `SFTRK_FLAG_GPS_VALID` (0x10) or `SFTRK_FLAG_GPS_INVALID` (0x20) from received packet | yes |
| 2 | `event_time` | uint32 | unix seconds | `days_from_civil()` on `gps.date`+`gps.time`; 0 until GPS date+time valid | yes (0 until fix) |
| 3 | `event_pps_micros` | uint32 | µs since PPS edge | `micros() - lastPpsMicros`; PPS ISR not latched yet | **no (always 0)** |
| 4 | `node_id` | uint16 | — | `LocationPacket.header.nodeId` (responder) | yes |
| 5 | `target_id` | uint16 | — | `LocationPacket.header.targetId` (this node) | yes |
| 6 | `packet_id` | uint16 | — | `LocationPacket.packet_id` (responder's counter) | yes |
| 7 | `rx_late7` | int32 | deg × 1e7 | Local `latestFix.lat_E7` (requester GPS) | yes (0 until fix) |
| 8 | `rx_lnge7` | int32 | deg × 1e7 | Local `latestFix.lng_E7` (requester GPS) | yes (0 until fix) |
| 9 | `rx_sats` | uint8 | — | Local `latestFix.sats` | yes |
| 10 | `tx_late7` | int32 | deg × 1e7 | `LocationPacket.gps_lat` (responder GPS) | yes |
| 11 | `tx_lnge7` | int32 | deg × 1e7 | `LocationPacket.gps_lng` (responder GPS) | yes |
| 12 | `tx_sats` | uint8 | — | `LocationPacket.gps_numSat` | yes |
| 13 | `rx_rssix10` | int16 | dBm × 10 | `radio.getRSSI()` at RX of `LocationPacket` (return path) | yes |
| 14 | `rx_snrx10` | int16 | dB × 10 | `round(radio.getSNR() * 10)` at RX of `LocationPacket` | yes |
| 15 | `tx_rssix10` | int16 | dBm × 10 | `LocationPacket.rx_rssi` (responder's RX of `REQ_LOG`, forward path) | yes |
| 16 | `tx_snrx10` | int16 | dB × 10 | `LocationPacket.rx_snr` (responder's RX of `REQ_LOG`) | yes |
| 17 | `packet_len` | uint8 | bytes | `sizeof(struct LocationPacket)` = 23 | yes |
| 18 | `latency_us` | uint32 | µs | `rxIrqMicros - reqLogTxDoneMicros` (round-trip: REQ_LOG TX_DONE → LocationPacket RX_DONE), local `micros()`; 0 if `!awaitingLogResponse` | yes (0 when unsolicited/missed TX_DONE) |

### rx vs tx prefix convention

Confusing but deliberate — named from the **logger's transaction perspective**, not the radio direction:

- `rx_*` = the **logger/requester** side (this node's RX event: its local GPS, the RSSI/SNR it measured receiving the reply).
- `tx_*` = the **beacon/responder** side (the remote node that transmitted the `LocationPacket`: its GPS fields, and the RSSI/SNR it measured when it received the `REQ_LOG`).

So `rx_rssix10` and `tx_rssix10` together capture **both halves of the link budget**: forward path (`REQ_LOG` → responder, logged as `tx_rssix10`) and return path (`LocationPacket` → requester, logged as `rx_rssix10`).

### Scaling

- Lat/lng: integer × 1e7 (≈ 1.1 cm resolution). Divide by 1e7 for degrees.
- RSSI/SNR: integer × 10. Divide by 10 for dBm / dB. Avoids float on the MCU; preserves one decimal of precision.

---

## 6. Timing model

### `event_time` (unix seconds)

Computed in `gpsPoll` from TinyGPSPlus when both `gps.date.isValid()` and `gps.time.isValid()`:

```
days = days_from_civil(year, month, day)   // Hinnant's civil-from-days, no time.h
unix_sec = days*86400 + hh*3600 + mm*60 + ss
```

Stored in `GpsFix.unixTime`, snapshotted under the GPS mutex at log time. **0 until the GPS module has emitted valid date + time sentences** (typically a few seconds after a fix is acquired). All `LogEvent` fields are single-threaded via the mutex — `gps` (TinyGPSPlus) is only touched from `gpsPoll`.

### `event_pps_micros` (sub-second µs) — NOT WIRED

Intended semantics: `micros() - lastPpsMicros`, where `lastPpsMicros` is latched in the PPS rising-edge ISR. Currently `activatePPS()` only prints "pps" and does not latch anything → this column is always 0. Wiring this is a planned task; until then, sub-second event timing is unavailable and `event_time` has ±1 s ambiguity relative to the true UTC second boundary.

### `latency_us` (round-trip µs)

The `LocationPacket` carries no transmit timestamp, but the requester measures the **round-trip latency** from radio IRQ timestamps on its own `micros()` clock — no GPS-PPS discipline, no clock sync between nodes:

```
REQ_LOG TX_DONE IRQ  →  reqLogTxDoneMicros = micros()   (latched in lora_handleRx TX_DONE case)
                         awaitingLogResponse = true

LocationPacket RX_DONE IRQ  →  rxIrqMicros = micros()    (passed from onRadioDio1 → handleRxDone → handle_location)

latency_us = rxIrqMicros - reqLogTxDoneMicros            (unsigned, single wrap-safe)
```

`latency_us` is 0 when `awaitingLogResponse` was false (unsolicited `LocationPacket`, or the TX_DONE IRQ was missed). `uint32_t` wraps at ~71.6 min of continuous `micros()` uptime; unsigned subtraction makes a single wrap correct, but a transaction that straddles two wraps would corrupt — in practice a `REQ_LOG`/`LocationPacket` exchange completes in seconds, so this is not a concern.

### What `latency_us` includes

| Component | Typical | Notes |
|---|---|---|
| Forward airtime | 50–1300 ms | 6-byte `REQ_LOG` on-air (SF/BW/CR dependent) |
| Responder turnaround | 1–20 ms | `handleRxDone` → `txPongTask` wakeup → `startTransmit` |
| Return airtime | 50–1300 ms | 23-byte `LocationPacket` on-air (dominant) |
| Modem + IRQ handling | 1–5 ms | SX1262 internal + ISR → queue → task |
| **Total** | ≈ forward + turnaround + return + few ms | Dominated by the two airtimes |

For a fixed SF/BW/CR config the round-trip is roughly constant; variation comes from responder scheduling jitter and SX1262 buffer hold. This is **not** the one-way airtime V1 estimated from two GPS-PPS timestamps — it is the full request/response cycle measured on one local clock.

### Why not `uint64` / GPS-PPS

V1 used two `uint64_t tx_gps_us`/`rx_gps_us` GPS-PPS-synced timestamps and a BigInt subtraction in JS. V2 drops that: the `LocationPacket` no longer carries a transmit timestamp (no `%llu` printf pitfall on nRF52 newlib-nano), and the round-trip fits comfortably in `uint32_t` (~71 min wrap). The PPS latch (`event_pps_micros`) remains a separate, still-unwired sub-second timing feature.

---

## 7. Known gaps / not-yet-wired

| Gap | Impact |
|---|---|
| PPS micros latch (`activatePPS` body) | `event_pps_micros` always 0; no sub-second timing |
| `event_time` requires GPS date+time | 0 until first valid NMEA date+time sentence (post-fix) |
| `range-lib.js` parser expects V1 column names | **Resolved** — `range-lib.js` now prefers V2 columns (`rx_late7`/`tx_late7`, `rx_rssix10` ÷ 10, `latency_us`) and keeps V1 aliases (`lat_e7`/`tx_lat_e7`, `rssi_dbm`, `tx_gps_us`/`rx_gps_us`) as a fallback so legacy logs still load. V2 CSV parses in `range-testing.html`. |
| `gps_avgGsvSnr` in `LocationPacket` | Reserved, always 0 from tx_test |
| `tx_rssix10` / `tx_snrx10` value | Reflects responder's RX of the `REQ_LOG` (6-byte packet). RSSI on a 6-byte packet is still a valid link-quality sample. |

---

## 8. Changes from V1

- **Beacon struct removed.** Replaced by `Header` + `AckPacket` (6 B) + `LocationPacket` (23 B) in `pkt.h`. No more 22-byte `Beacon` with `uint64 tx_gps_us`.
- **Request/response model.** V1 was a one-way broadcast beacon. V2 is a two-step `REQ_LOG` → `LocationPacket` transaction, so the requester can measure return-path RSSI/SNR and the responder can measure forward-path RSSI/SNR.
- **CSV restructured.** 14 cols → 18 cols. New identity block (`node_id`, `target_id`, `packet_id`), split GPS into `rx_*` / `tx_*`, split RSSI/SNR into `rx_*` / `tx_*`, added `event_pps_micros`, `packet_len`, and `latency_us`. Dropped `utc_iso`, `time_valid`, `gps_fix_time_us`.
- **RSSI/SNR stored ×10** (int16), not raw float dBm. Avoids float on MCU, matches wire format.
- **`packet_id` retained** (was in V1, dropped during V2 struct refactor, now restored) for packet-delivery-ratio computation.
- **Latency reworked.** V1's two GPS-PPS-synced `tx_gps_us`/`rx_gps_us` (BigInt subtraction, requires clock sync) replaced by a single `latency_us` round-trip µs measured from radio IRQ timestamps on the requester's local `micros()` — no GPS-PPS discipline, no `%llu` pitfall. See §6.

---

## 9. Reference

- `include/pkt.h` — wire structs, flag enum, `sftrk_make_*` / `sftrk_validate_packet`
- `src/main.cpp` — requester/logger firmware (nicenano env): `handle_location`, `logWriteToCsv`, `gpsPoll`, `days_from_civil`
- `tx_test/main.cpp` — responder/beacon firmware (tx_test env): `txPongTask`, `handleRxDone`
- `platformio.ini` — env definitions, `NODE_ID` build flags
- `docs/PACKET_FORMAT_V1.md` — previous format (retired 22-byte beacon + 14-col CSV)
- `range-lib.js` — log processor (V2-compatible: prefers `rx_late7`/`tx_late7`/`rx_rssix10`/`latency_us`, falls back to V1 `lat_e7`/`tx_lat_e7`/`rssi_dbm`/`tx_gps_us`)
