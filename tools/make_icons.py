#!/usr/bin/env python3
"""Generate extension icons: two white pause bars on an indigo disc.

Writes icons/icon{16,32,48,128}.png using only the standard library.
"""

import struct
import zlib
from pathlib import Path

INDIGO = (79, 70, 229)  # #4F46E5
WHITE = (255, 255, 255)


def make_icon(size: int) -> bytes:
    center = (size - 1) / 2
    radius = size / 2
    bar_w = size * 0.14
    bar_h = size * 0.44
    gap = size * 0.11

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Anti-aliased disc edge via distance from center.
            dist = ((x - center) ** 2 + (y - center) ** 2) ** 0.5
            alpha = max(0.0, min(1.0, radius - dist))
            in_bar_y = abs(y - center) <= bar_h / 2
            in_left = abs(x - (center - gap / 2 - bar_w / 2)) <= bar_w / 2
            in_right = abs(x - (center + gap / 2 + bar_w / 2)) <= bar_w / 2
            color = WHITE if in_bar_y and (in_left or in_right) else INDIGO
            row += bytes((*color, round(alpha * 255)))
        rows.append(bytes(row))
    return encode_png(size, size, rows)


def encode_png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        path = out_dir / f"icon{size}.png"
        path.write_bytes(make_icon(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
