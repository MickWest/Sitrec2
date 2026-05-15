# ASTERIX Sample Files

Source: https://github.com/CroatiaControlLtd/asterix/tree/master/asterix/sample_data
License: GPL (project license)

## Files

| File | Bytes | Format | Notes |
|------|-------|--------|-------|
| `cat048.raw` | 48 | Raw ASTERIX CAT-048 | Single message, no framing. CAT byte 0x30, length 0x0030. SAC=247, SIC=2. |
| `cat062cat065.raw` | 195 | Raw ASTERIX CAT-062 + CAT-065 | Multi-message raw stream. |
| `cat_034_048.pcap` | 12,770 | libpcap of UDP multicast | **The useful one.** 120 messages: 86× CAT-048 (target reports) + 34× CAT-034 (radar status). Real Croatia Control Mode-S monoradar data: aircraft (e.g. DLH65A at FL330, ground speed 434 kt, Mode-S address 0x3C660C), full position (RHO, THETA), track numbers. Microsecond pcap timestamps. |
| `cat_062_065.pcap` | 255 | libpcap of UDP multicast | Small CAT-062 (system tracks) + CAT-065 (service status) sample. |

## Decoding

`pip install asterix_decoder` gives you a Python parser with these same samples bundled.

```python
import asterix
parsed = asterix.parse(bytearray(open('cat048.raw','rb').read()))
```

## What's NOT here

- **FAA CD-2 / CD-2T binary** — not publicly available. US-only FAA format, runs on private FAA networks between radar sites and ARTCCs. Spec is FAA-E-2679 / Order 6350.23 but no public sample data files exist. To get samples you'd need: an FAA contract, an NTSB docket pull from 84 RADES, a Sunhillo/Sensis dev kit, or a FOIA pull for a specific event (and even then FAA usually delivers processed tracks, not raw CD-2).
- **ARSR-4 native output** — same situation. Joint Surveillance System internal format. No public samples.

ASTERIX CAT-048 is the closest practical analog and is structurally similar to CD-2 in what it carries (plot-level target reports with range/azimuth/Mode-A/altitude/Mode-S address).
