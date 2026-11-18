#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Convert a SWF file into an editable H5 package:
- scene.json (timeline, sprites, buttons, placement, cxform, clipDepth, morphs, symbols)
- lesson.json (human-editable metadata)
- assets/images/ (DefineBitsLossless/2 -> PNG, DefineBitsJPEG2/3 -> PNG/JPG with alpha & dimensions)
- assets/shapes/ (DefineShape1/2/3/4, DefineMorphShape1/2 & DefineText1/2 -> SVG)
- assets/audio/  (DefineSound & SoundStreamBlock -> MP3)
"""

import io
import json
import math
import os
import struct
import zlib

try:
    from PIL import Image
except ImportError:
    Image = None


class BitReader:
    def __init__(self, data: bytes, byte_pos: int = 0):
        self.data = data
        self.byte_pos = byte_pos
        self.bit_pos = 0

    def align(self):
        if self.bit_pos > 0:
            self.byte_pos += 1
            self.bit_pos = 0

    def read_bits(self, n: int) -> int:
        if n == 0:
            return 0
        val = 0
        for _ in range(n):
            if self.byte_pos >= len(self.data):
                val <<= 1
            else:
                b = self.data[self.byte_pos]
                bit = (b >> (7 - self.bit_pos)) & 1
                val = (val << 1) | bit
                self.bit_pos += 1
                if self.bit_pos == 8:
                    self.bit_pos = 0
                    self.byte_pos += 1
        return val

    def read_sb(self, n: int) -> int:
        if n == 0:
            return 0
        v = self.read_bits(n)
        if v & (1 << (n - 1)):
            v -= 1 << n
        return v

    def read_fb(self, n: int) -> float:
        return self.read_sb(n) / 65536.0

    def read_u8(self) -> int:
        self.align()
        v = self.data[self.byte_pos]
        self.byte_pos += 1
        return v

    def read_u16(self) -> int:
        self.align()
        v = struct.unpack_from("<H", self.data, self.byte_pos)[0]
        self.byte_pos += 2
        return v

    def read_s16(self) -> int:
        self.align()
        v = struct.unpack_from("<h", self.data, self.byte_pos)[0]
        self.byte_pos += 2
        return v

    def read_u32(self) -> int:
        self.align()
        v = struct.unpack_from("<I", self.data, self.byte_pos)[0]
        self.byte_pos += 4
        return v

    def read_bytes(self, n: int) -> bytes:
        self.align()
        b = self.data[self.byte_pos : self.byte_pos + n]
        self.byte_pos += n
        return b

    def read_cstring(self) -> str:
        self.align()
        end = self.data.find(b"\x00", self.byte_pos)
        if end == -1:
            s = self.data[self.byte_pos :].decode("utf-8", "ignore")
            self.byte_pos = len(self.data)
            return s
        s = self.data[self.byte_pos : end].decode("utf-8", "ignore")
        self.byte_pos = end + 1
        return s


def read_rect(br: BitReader):
    br.align()
    nbits = br.read_bits(5)
    xmin = br.read_sb(nbits) / 20.0
    xmax = br.read_sb(nbits) / 20.0
    ymin = br.read_sb(nbits) / 20.0
    ymax = br.read_sb(nbits) / 20.0
    br.align()
    return [round(xmin, 2), round(ymin, 2), round(xmax, 2), round(ymax, 2)]


def read_matrix(br: BitReader):
    br.align()
    a, d = 1.0, 1.0
    b, c = 0.0, 0.0
    if br.read_bits(1):
        nb = br.read_bits(5)
        a = br.read_fb(nb)
        d = br.read_fb(nb)
    if br.read_bits(1):
        nb = br.read_bits(5)
        b = br.read_fb(nb)
        c = br.read_fb(nb)
    nb = br.read_bits(5)
    tx = br.read_sb(nb) / 20.0
    ty = br.read_sb(nb) / 20.0
    br.align()
    return [round(a, 5), round(b, 5), round(c, 5), round(d, 5), round(tx, 2), round(ty, 2)]


def read_cxform(br: BitReader, with_alpha: bool = True):
    br.align()
    has_add = br.read_bits(1)
    has_mult = br.read_bits(1)
    nb = br.read_bits(4)
    mult = [1.0, 1.0, 1.0, 1.0]
    add = [0, 0, 0, 0]
    n = 4 if with_alpha else 3
    if has_mult:
        for i in range(n):
            mult[i] = round(br.read_sb(nb) / 256.0, 4)
    if has_add:
        for i in range(n):
            add[i] = br.read_sb(nb)
    br.align()
    return {"mult": mult, "add": add}


def encode_png(width: int, height: int, rgba_rows: list[bytes]) -> bytes:
    def chunk(ctype: bytes, data: bytes) -> bytes:
        c = ctype + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rgba_rows)
    idat = zlib.compress(raw, 6)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def decode_lossless_to_png(data: bytes, has_alpha: bool) -> tuple[bytes, int, int]:
    cid, fmt, w, h = struct.unpack_from("<HBHH", data, 0)
    pos = 7
    color_table_size = 0
    if fmt == 3:
        color_table_size = data[pos] + 1
        pos += 1
    decompressed = zlib.decompress(data[pos:])
    rows = []
    if fmt == 5:
        stride = w * 4
        for y in range(h):
            row = bytearray(w * 4)
            base = y * stride
            for x in range(w):
                p = base + x * 4
                if has_alpha:
                    a, r, g, b = decompressed[p], decompressed[p + 1], decompressed[p + 2], decompressed[p + 3]
                    if 0 < a < 255:
                        r = min(255, int(r * 255 / a))
                        g = min(255, int(g * 255 / a))
                        b = min(255, int(b * 255 / a))
                else:
                    a, r, g, b = 255, decompressed[p + 1], decompressed[p + 2], decompressed[p + 3]
                q = x * 4
                row[q : q + 4] = bytes((r, g, b, a))
            rows.append(bytes(row))
    elif fmt == 3:
        bpp = 4 if has_alpha else 3
        palette = []
        for i in range(color_table_size):
            p = i * bpp
            if has_alpha:
                r, g, b, a = decompressed[p], decompressed[p + 1], decompressed[p + 2], decompressed[p + 3]
                if 0 < a < 255:
                    r = min(255, int(r * 255 / a))
                    g = min(255, int(g * 255 / a))
                    b = min(255, int(b * 255 / a))
                palette.append((r, g, b, a))
            else:
                palette.append((decompressed[p], decompressed[p + 1], decompressed[p + 2], 255))
        pix_off = color_table_size * bpp
        stride = (w + 3) & ~3
        for y in range(h):
            row = bytearray(w * 4)
            base = pix_off + y * stride
            for x in range(w):
                idx = decompressed[base + x]
                r, g, b, a = palette[idx] if idx < len(palette) else (0, 0, 0, 0)
                q = x * 4
                row[q : q + 4] = bytes((r, g, b, a))
            rows.append(bytes(row))
    return encode_png(w, h, rows), w, h


def decode_jpeg3_to_image(data: bytes) -> tuple[bytes, str, int, int]:
    cid, alpha_off = struct.unpack_from("<HI", data, 0)
    jpeg_data = data[6 : 6 + alpha_off]
    # Strip erroneous SWF JPEG header sequence FF D9 FF D8 if present
    jpeg_data = jpeg_data.replace(b"\xff\xd9\xff\xd8", b"")
    alpha_compressed = data[6 + alpha_off :]
    if Image is not None:
        try:
            im = Image.open(io.BytesIO(jpeg_data)).convert("RGBA")
            w, h = im.size
            if alpha_compressed:
                try:
                    alpha_bytes = zlib.decompress(alpha_compressed)
                    if len(alpha_bytes) >= w * h:
                        r_ch, g_ch, b_ch, _ = im.split()
                        # Unpremultiply if needed and attach alpha channel
                        alpha_im = Image.frombytes("L", (w, h), alpha_bytes[: w * h])
                        im = Image.merge("RGBA", (r_ch, g_ch, b_ch, alpha_im))
                except Exception:
                    pass
            out_buf = io.BytesIO()
            im.save(out_buf, format="PNG")
            return out_buf.getvalue(), "png", w, h
        except Exception:
            pass
    return jpeg_data, "jpg", 100, 100


def read_rgba(br: BitReader, has_alpha: bool):
    r, g, b = br.read_u8(), br.read_u8(), br.read_u8()
    a = br.read_u8() if has_alpha else 255
    return r, g, b, a


def fmt_color(rgba):
    r, g, b, a = rgba
    return f"#{r:02x}{g:02x}{b:02x}", round(a / 255.0, 3)


def read_style_arrays(br: BitReader, ver: int, shape_id: int, batch_idx: int, images_meta: dict):
    has_alpha = ver >= 3
    fcnt = br.read_u8()
    if fcnt == 0xFF and ver >= 2:
        fcnt = br.read_u16()
    fills = [None]
    defs = []
    for i in range(1, fcnt + 1):
        ftype = br.read_u8()
        if ftype == 0x00:
            col, op = fmt_color(read_rgba(br, has_alpha))
            fills.append({"type": "solid", "color": col, "opacity": op})
        elif ftype in (0x10, 0x12, 0x13):
            gmat = read_matrix(br)
            br.align()
            spread = br.read_bits(2)
            _interp = br.read_bits(2)
            nc = br.read_bits(4)
            stops = []
            for _ in range(nc):
                ratio = br.read_u8() / 255.0
                col, op = fmt_color(read_rgba(br, has_alpha))
                stops.append((round(ratio * 100, 1), col, op))
            if ftype == 0x13:
                _focal = br.read_s16() / 256.0
            gid = f"grad_{shape_id}_{batch_idx}_{i}"
            spread_str = {0: "pad", 1: "reflect", 2: "repeat"}.get(spread, "pad")
            stop_xml = "".join(
                f'<stop offset="{pct}%" stop-color="{c}"' + (f' stop-opacity="{o}"' if o < 1 else "") + "/>"
                for pct, c, o in stops
            )
            if ftype == 0x10:
                x1 = gmat[0] * -819.2 + gmat[4]
                y1 = gmat[1] * -819.2 + gmat[5]
                x2 = gmat[0] * 819.2 + gmat[4]
                y2 = gmat[1] * 819.2 + gmat[5]
                defs.append(
                    f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
                    f'x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" spreadMethod="{spread_str}">{stop_xml}</linearGradient>'
                )
            else:
                m_str = f"matrix({gmat[0]} {gmat[1]} {gmat[2]} {gmat[3]} {gmat[4]} {gmat[5]})"
                defs.append(
                    f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="819.2" '
                    f'gradientTransform="{m_str}" spreadMethod="{spread_str}">{stop_xml}</radialGradient>'
                )
            fills.append({"type": "grad", "id": gid})
        elif ftype in (0x40, 0x41, 0x42, 0x43):
            bmp_id = br.read_u16()
            bmat = read_matrix(br)
            pid = f"pat_{shape_id}_{batch_idx}_{i}"
            im = images_meta.get(bmp_id)
            if im and bmp_id != 0xFFFF:
                # CRITICAL: SWF bitmap matrix scale is in twips/pixel (20.0 = 1:1).
                # Since SVG path coordinates are already divided by 20.0 (in pixels),
                # we MUST divide bmat[0..3] by 20.0 (NOT multiply by 20)!
                m_str = (
                    f"matrix({bmat[0] / 20.0:.5f} {bmat[1] / 20.0:.5f} "
                    f"{bmat[2] / 20.0:.5f} {bmat[3] / 20.0:.5f} {bmat[4]} {bmat[5]})"
                )
                w, h = im["w"] or 100, im["h"] or 100
                defs.append(
                    f'<pattern id="{pid}" patternUnits="userSpaceOnUse" width="{w}" height="{h}" patternTransform="{m_str}">'
                    f'<image href="../images/{im["file"]}" width="{w}" height="{h}"/></pattern>'
                )
                fills.append({"type": "pat", "id": pid})
            else:
                # Invalid/placeholder bitmap fill (0xFFFF) -> transparent
                fills.append({"type": "solid", "color": "none", "opacity": 0.0})

    lcnt = br.read_u8()
    if lcnt == 0xFF and ver >= 2:
        lcnt = br.read_u16()
    lines = [None]
    for _ in range(1, lcnt + 1):
        width = br.read_u16() / 20.0
        if ver == 4:
            br.align()
            _start_cap = br.read_bits(2)
            join_style = br.read_bits(2)
            has_fill = br.read_bits(1)
            _no_hscale = br.read_bits(1)
            _no_vscale = br.read_bits(1)
            _pixel_hint = br.read_bits(1)
            br.read_bits(5)
            _no_close = br.read_bits(1)
            _end_cap = br.read_bits(2)
            if join_style == 2:
                br.read_u16()
            if has_fill:
                sub_fills, _, sub_defs = read_style_arrays(br, ver, shape_id, batch_idx, images_meta)
                defs.extend(sub_defs)
                col = sub_fills[1]["color"] if len(sub_fills) > 1 and sub_fills[1] and sub_fills[1]["type"] == "solid" else "#000000"
                lines.append({"width": max(width, 0.5), "color": col, "opacity": 1.0})
            else:
                col, op = fmt_color(read_rgba(br, True))
                lines.append({"width": max(width, 0.5), "color": col, "opacity": op})
        else:
            col, op = fmt_color(read_rgba(br, has_alpha))
            lines.append({"width": max(width, 0.5), "color": col, "opacity": op})

    return fills, lines, defs


def edges_to_svg_path(edges: list) -> str:
    if not edges:
        return ""
    by_start = {}
    used = [False] * len(edges)
    for idx, e in enumerate(edges):
        pt = e[0]
        by_start.setdefault(pt, []).append(idx)

    parts = []
    for i in range(len(edges)):
        if used[i]:
            continue
        used[i] = True
        cur = edges[i]
        sx, sy = cur[0]
        parts.append(f"M{sx / 20.0:.2f} {sy / 20.0:.2f}")
        while True:
            if cur[1] == "L":
                ex, ey = cur[2]
                parts.append(f"L{ex / 20.0:.2f} {ey / 20.0:.2f}")
            else:
                cx, cy = cur[2]
                ex, ey = cur[3]
                parts.append(f"Q{cx / 20.0:.2f} {cy / 20.0:.2f} {ex / 20.0:.2f} {ey / 20.0:.2f}")
            end_pt = (ex, ey)
            cands = by_start.get(end_pt, [])
            nxt_idx = None
            for c in cands:
                if not used[c]:
                    nxt_idx = c
                    break
            if nxt_idx is None:
                break
            used[nxt_idx] = True
            cur = edges[nxt_idx]
        if end_pt == (sx, sy):
            parts.append("Z")
    return " ".join(parts)


def shape_to_svg(data: bytes, ver: int, images_meta: dict):
    br = BitReader(data)
    sid = br.read_u16()
    bounds = read_rect(br)
    if ver == 4:
        _edge_bounds = read_rect(br)
        br.read_u8()

    batch_idx = 0
    fills, lines, all_defs = read_style_arrays(br, ver, sid, batch_idx, images_meta)
    br.align()
    num_fill_bits = br.read_bits(4)
    num_line_bits = br.read_bits(4)

    # Track coordinates in exact integer twips so vertex matching in edges_to_svg_path is 100% exact
    cur_x, cur_y = 0, 0
    fs0, fs1, ls = 0, 0, 0
    fill_edges = {}
    line_edges = {}
    svg_paths = []

    def rev_edge(e):
        if e[1] == "L":
            return (e[2], "L", e[0])
        return (e[3], "Q", e[2], e[0])

    def flush_batch():
        for f_idx, elist in sorted(fill_edges.items()):
            if f_idx <= 0 or f_idx >= len(fills) or not fills[f_idx]:
                continue
            st = fills[f_idx]
            if st["type"] == "solid" and (st["color"] == "none" or st["opacity"] <= 0):
                continue
            d_str = edges_to_svg_path(elist)
            if not d_str:
                continue
            if st["type"] == "solid":
                op_attr = f' fill-opacity="{st["opacity"]}"' if st["opacity"] < 1 else ""
                svg_paths.append(f'<path d="{d_str}" fill="{st["color"]}"{op_attr} fill-rule="evenodd"/>')
            else:
                svg_paths.append(f'<path d="{d_str}" fill="url(#{st["id"]})" fill-rule="evenodd"/>')
        for l_idx, elist in sorted(line_edges.items()):
            if l_idx <= 0 or l_idx >= len(lines) or not lines[l_idx]:
                continue
            st = lines[l_idx]
            if st["opacity"] <= 0:
                continue
            d_str = edges_to_svg_path(elist)
            if not d_str:
                continue
            op_attr = f' stroke-opacity="{st["opacity"]}"' if st["opacity"] < 1 else ""
            svg_paths.append(
                f'<path d="{d_str}" fill="none" stroke="{st["color"]}" stroke-width="{st["width"]:.2f}" '
                f'stroke-linecap="round" stroke-linejoin="round"{op_attr}/>'
            )
        fill_edges.clear()
        line_edges.clear()

    while True:
        type_flag = br.read_bits(1)
        if type_flag == 0:
            flags = br.read_bits(5)
            if flags == 0:
                break
            if flags & 0x01:
                mb = br.read_bits(5)
                cur_x = br.read_sb(mb)
                cur_y = br.read_sb(mb)
            if flags & 0x02:
                fs0 = br.read_bits(num_fill_bits)
            if flags & 0x04:
                fs1 = br.read_bits(num_fill_bits)
            if flags & 0x08:
                ls = br.read_bits(num_line_bits)
            if flags & 0x10:
                # CRITICAL: Flush current batch BEFORE resetting style arrays!
                flush_batch()
                batch_idx += 1
                fills, lines, new_defs = read_style_arrays(br, ver, sid, batch_idx, images_meta)
                all_defs.extend(new_defs)
                br.align()
                num_fill_bits = br.read_bits(4)
                num_line_bits = br.read_bits(4)
                fs0, fs1, ls = 0, 0, 0
        else:
            straight = br.read_bits(1)
            nb = br.read_bits(4) + 2
            p0 = (cur_x, cur_y)
            if straight:
                gen = br.read_bits(1)
                if gen:
                    dx = br.read_sb(nb)
                    dy = br.read_sb(nb)
                else:
                    vert = br.read_bits(1)
                    if vert:
                        dx, dy = 0, br.read_sb(nb)
                    else:
                        dx, dy = br.read_sb(nb), 0
                cur_x += dx
                cur_y += dy
                edge = (p0, "L", (cur_x, cur_y))
            else:
                cx = cur_x + br.read_sb(nb)
                cy = cur_y + br.read_sb(nb)
                cur_x = cx + br.read_sb(nb)
                cur_y = cy + br.read_sb(nb)
                edge = (p0, "Q", (cx, cy), (cur_x, cur_y))
            if fs0 > 0:
                fill_edges.setdefault(fs0, []).append(rev_edge(edge))
            if fs1 > 0:
                fill_edges.setdefault(fs1, []).append(edge)
            if ls > 0:
                line_edges.setdefault(ls, []).append(edge)

    flush_batch()
    w = max(0.05, round(bounds[2] - bounds[0], 2))
    h = max(0.05, round(bounds[3] - bounds[1], 2))
    defs_str = f"<defs>{''.join(all_defs)}</defs>" if all_defs else ""
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{bounds[0]:.2f} {bounds[1]:.2f} {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}">{defs_str}{"".join(svg_paths)}</svg>'
    return sid, svg, bounds


def parse_morph_to_svg(data: bytes, tid: int):
    """Parse DefineMorphShape (46) and DefineMorphShape2 (84) into SVG + morph bounds metadata."""
    br = BitReader(data)
    cid = br.read_u16()
    sb = read_rect(br)
    eb = read_rect(br)
    if tid == 84:
        _seb = read_rect(br)
        _eeb = read_rect(br)
        br.read_u8()
    _offset = br.read_u32()
    fcnt = br.read_u8()
    if fcnt == 0xFF:
        fcnt = br.read_u16()
    fills = [None]
    for _ in range(fcnt):
        ft = br.read_u8()
        if ft == 0x00:
            _sc = fmt_color(read_rgba(br, True))
            ec, eop = fmt_color(read_rgba(br, True))
            fills.append({"type": "solid", "color": ec, "opacity": eop})
        elif ft in (0x10, 0x12, 0x13):
            read_matrix(br)
            read_matrix(br)
            nc = br.read_u8()
            ec, eop = "#ff9900", 1.0
            for _ in range(nc):
                br.read_u8()
                read_rgba(br, True)
                br.read_u8()
                ec, eop = fmt_color(read_rgba(br, True))
            if ft == 0x13:
                br.read_s16()
                br.read_s16()
            fills.append({"type": "solid", "color": ec, "opacity": eop})
        elif ft in (0x40, 0x41, 0x42, 0x43):
            br.read_u16()
            read_matrix(br)
            read_matrix(br)
            fills.append({"type": "solid", "color": "#ff9900", "opacity": 1.0})

    lcnt = br.read_u8()
    if lcnt == 0xFF:
        lcnt = br.read_u16()
    lines = [None]
    for _ in range(lcnt):
        _sw = br.read_u16() / 20.0
        ew = br.read_u16() / 20.0
        if tid == 84:
            flags = br.read_u16()
            if ((flags >> 12) & 3) == 2:
                br.read_u16()
            if flags & 0x08:
                lines.append({"width": max(ew, 1.0), "color": "#ffcc00", "opacity": 1.0})
            else:
                read_rgba(br, True)
                ec, eop = fmt_color(read_rgba(br, True))
                lines.append({"width": max(ew, 1.0), "color": ec, "opacity": eop})
        else:
            read_rgba(br, True)
            ec, eop = fmt_color(read_rgba(br, True))
            lines.append({"width": max(ew, 1.0), "color": ec, "opacity": eop})

    x0, y0, x1, y1 = eb
    w = max(0.5, round(x1 - x0, 2))
    h = max(0.5, round(y1 - y0, 2))
    svg_paths = []
    if len(fills) > 1 and fills[1]:
        st = fills[1]
        op_attr = f' fill-opacity="{st["opacity"]}"' if st["opacity"] < 1 else ""
        svg_paths.append(
            f'<path d="M{x0:.2f} {y0:.2f} L{x1:.2f} {y0:.2f} L{x1:.2f} {y1:.2f} L{x0:.2f} {y1:.2f} Z" '
            f'fill="{st["color"]}"{op_attr} fill-rule="evenodd"/>'
        )
    elif len(lines) > 1 and lines[1]:
        st = lines[1]
        op_attr = f' stroke-opacity="{st["opacity"]}"' if st["opacity"] < 1 else ""
        if w >= h:
            ym = round((y0 + y1) / 2, 2)
            svg_paths.append(
                f'<path d="M{x0:.2f} {ym:.2f} L{x1:.2f} {ym:.2f}" fill="none" stroke="{st["color"]}" '
                f'stroke-width="{st["width"]:.2f}" stroke-linecap="round"{op_attr}/>'
            )
        else:
            xm = round((x0 + x1) / 2, 2)
            svg_paths.append(
                f'<path d="M{xm:.2f} {y0:.2f} L{xm:.2f} {y1:.2f}" fill="none" stroke="{st["color"]}" '
                f'stroke-width="{st["width"]:.2f}" stroke-linecap="round"{op_attr}/>'
            )
    else:
        svg_paths.append(
            f'<path d="M{x0:.2f} {y0:.2f} L{x1:.2f} {y0:.2f} L{x1:.2f} {y1:.2f} L{x0:.2f} {y1:.2f} Z" '
            f'fill="#000000" fill-rule="evenodd"/>'
        )
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}">{"".join(svg_paths)}</svg>'
    return cid, svg, eb, sb


def parse_font3(data: bytes):
    br = BitReader(data)
    fid = br.read_u16()
    flags = br.read_u8()
    _lang = br.read_u8()
    name_len = br.read_u8()
    br.read_bytes(name_len)
    num_glyphs = br.read_u16()
    if num_glyphs == 0:
        return fid, []
    wide_offsets = bool(flags & 0x08)
    offsets_start = br.byte_pos
    offsets = [br.read_u32() if wide_offsets else br.read_u16() for _ in range(num_glyphs)]
    _code_off = br.read_u32() if wide_offsets else br.read_u16()
    glyphs = []
    for i in range(num_glyphs):
        gbr = BitReader(data, offsets_start + offsets[i])
        nfb = gbr.read_bits(4)
        nlb = gbr.read_bits(4)
        cx, cy = 0.0, 0.0
        parts = []
        while True:
            tf = gbr.read_bits(1)
            if tf == 0:
                gf = gbr.read_bits(5)
                if gf == 0:
                    break
                if gf & 0x01:
                    mb = gbr.read_bits(5)
                    cx = gbr.read_sb(mb) / 20.0
                    cy = gbr.read_sb(mb) / 20.0
                    parts.append(f"M{cx:.2f} {cy:.2f}")
                if gf & 0x02:
                    gbr.read_bits(nfb)
                if gf & 0x04:
                    gbr.read_bits(nfb)
                if gf & 0x08:
                    gbr.read_bits(nlb)
            else:
                st = gbr.read_bits(1)
                nb = gbr.read_bits(4) + 2
                if st:
                    gen = gbr.read_bits(1)
                    if gen:
                        dx, dy = gbr.read_sb(nb) / 20.0, gbr.read_sb(nb) / 20.0
                    else:
                        vt = gbr.read_bits(1)
                        dx, dy = (0.0, gbr.read_sb(nb) / 20.0) if vt else (gbr.read_sb(nb) / 20.0, 0.0)
                    cx += dx
                    cy += dy
                    parts.append(f"L{cx:.2f} {cy:.2f}")
                else:
                    qx = cx + gbr.read_sb(nb) / 20.0
                    qy = cy + gbr.read_sb(nb) / 20.0
                    cx = qx + gbr.read_sb(nb) / 20.0
                    cy = qy + gbr.read_sb(nb) / 20.0
                    parts.append(f"Q{qx:.2f} {qy:.2f} {cx:.2f} {cy:.2f}")
        glyphs.append(" ".join(parts))
    return fid, glyphs


def parse_define_text(data: bytes, has_alpha: bool, fonts: dict):
    br = BitReader(data)
    cid = br.read_u16()
    bounds = read_rect(br)
    tmat = read_matrix(br)
    gbits = br.read_u8()
    abits = br.read_u8()
    cur_font = None
    cur_col = "#000000"
    cur_op = 1.0
    cur_x, cur_y = 0.0, 0.0
    cur_h = 12.0
    paths = []
    while True:
        hdr = br.read_u8()
        if hdr == 0:
            break
        if hdr & 0x80:
            if hdr & 0x08:
                cur_font = br.read_u16()
            if hdr & 0x04:
                cur_col, cur_op = fmt_color(read_rgba(br, has_alpha))
            if hdr & 0x01:
                cur_x = br.read_s16() / 20.0
            if hdr & 0x02:
                cur_y = br.read_s16() / 20.0
            if hdr & 0x08:
                cur_h = br.read_u16() / 20.0
        else:
            ng = hdr & 0x7F
            glist = fonts.get(cur_font, [])
            scale = cur_h / 1024.0
            for _ in range(ng):
                gi = br.read_bits(gbits)
                adv = br.read_sb(abits) / 20.0
                if 0 <= gi < len(glist) and glist[gi]:
                    op_attr = f' fill-opacity="{cur_op}"' if cur_op < 1 else ""
                    paths.append(
                        f'<path d="{glist[gi]}" fill="{cur_col}"{op_attr} fill-rule="evenodd" '
                        f'transform="translate({cur_x:.2f} {cur_y:.2f}) scale({scale:.5f})"/>'
                    )
                cur_x += adv
            br.align()
    m_str = f"matrix({tmat[0]} {tmat[1]} {tmat[2]} {tmat[3]} {tmat[4]} {tmat[5]})"
    w = max(0.05, round(bounds[2] - bounds[0], 2))
    h = max(0.05, round(bounds[3] - bounds[1], 2))
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{bounds[0]:.2f} {bounds[1]:.2f} {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}"><g transform="{m_str}">{"".join(paths)}</g></svg>'
    return cid, svg, bounds


def parse_place_object(data: bytes, ver: int):
    br = BitReader(data)
    flags = br.read_u8()
    _flags2 = br.read_u8() if ver == 3 else 0
    depth = br.read_u16()
    info = {"depth": depth}
    if flags & 0x02:
        info["cid"] = br.read_u16()
    if flags & 0x04:
        info["matrix"] = read_matrix(br)
    if flags & 0x08:
        info["cxform"] = read_cxform(br, True)
    if flags & 0x10:
        info["ratio"] = br.read_u16()
    if flags & 0x20:
        info["name"] = br.read_cstring()
    if flags & 0x40:
        info["clipDepth"] = br.read_u16()
    return info


def parse_timeline(tags: list[tuple[int, bytes]]) -> dict:
    frames = []
    cur_label = None
    cur_actions = []
    cur_sounds = []
    stream_mp3 = bytearray()
    stream_rate = None

    for tid, data in tags:
        if tid == 1:  # ShowFrame
            frames.append({
                "label": cur_label,
                "actions": cur_actions,
                "sounds": cur_sounds,
            })
            cur_label = None
            cur_actions = []
            cur_sounds = []
        elif tid == 43:  # FrameLabel
            cur_label = data.split(b"\x00", 1)[0].decode("utf-8", "ignore")
        elif tid == 26:  # PlaceObject2
            p = parse_place_object(data, 2)
            cur_actions.append({"op": "place", **p})
        elif tid == 70:  # PlaceObject3
            p = parse_place_object(data, 3)
            cur_actions.append({"op": "place", **p})
        elif tid == 28:  # RemoveObject2
            depth = struct.unpack_from("<H", data, 0)[0]
            cur_actions.append({"op": "remove", "depth": depth})
        elif tid == 5:  # RemoveObject
            _cid, depth = struct.unpack_from("<HH", data, 0)
            cur_actions.append({"op": "remove", "depth": depth})
        elif tid == 15:  # StartSound
            sid = struct.unpack_from("<H", data, 0)[0]
            sflags = data[2]
            stop = bool(sflags & 0x20)
            cur_sounds.append({"sid": sid, "stop": stop})
        elif tid in (18, 45):  # SoundStreamHead / 2
            fmt = data[1] >> 4
            if fmt == 2:
                stream_rate = (data[1] >> 2) & 3
        elif tid == 19:  # SoundStreamBlock
            if stream_rate is not None and len(data) > 4:
                stream_mp3.extend(data[4:])

    return {
        "frameCount": len(frames),
        "frames": frames,
        "streamMp3": bytes(stream_mp3) if len(stream_mp3) > 0 else None,
    }


def parse_button2(data: bytes) -> dict:
    br = BitReader(data)
    bid = br.read_u16()
    _flags = br.read_u8()
    _action_offset = br.read_u16()
    states = {"up": [], "over": [], "down": [], "hit": []}
    while True:
        sflags = br.read_u8()
        if sflags == 0:
            break
        cid = br.read_u16()
        depth = br.read_u16()
        mat = read_matrix(br)
        cx = read_cxform(br, True)
        if sflags & 0x10:
            fcnt = br.read_u8()
            for _ in range(fcnt):
                fid = br.read_u8()
                if fid == 0: br.read_bytes(23)
                elif fid == 1: br.read_bytes(9)
                elif fid == 2: br.read_bytes(15)
                elif fid == 3: br.read_bytes(27)
                elif fid == 4: br.read_bytes(16)
                elif fid == 5: br.read_bytes(12)
                elif fid == 6: br.read_bytes(80)
        if sflags & 0x20:
            br.read_u8()
        rec = {"cid": cid, "depth": depth, "matrix": mat, "cxform": cx}
        if sflags & 0x01:
            states["up"].append(rec)
        if sflags & 0x02:
            states["over"].append(rec)
        if sflags & 0x04:
            states["down"].append(rec)
        if sflags & 0x08:
            states["hit"].append(rec)
    return {"id": bid, "states": states}


def extract_abc_strings(data: bytes) -> list[str]:
    p = 4
    while p < len(data) and data[p] != 0:
        p += 1
    p += 1
    if p + 4 > len(data):
        return []
    abc = data[p:]
    p = 4

    def u30():
        nonlocal p
        res = 0
        shift = 0
        while True:
            b = abc[p]
            p += 1
            res |= (b & 0x7F) << shift
            if not (b & 0x80):
                return res
            shift += 7

    for _ in range(max(0, u30() - 1)):
        u30()
    for _ in range(max(0, u30() - 1)):
        u30()
    n = u30()
    if n > 1:
        p += (n - 1) * 8
    n = u30()
    strs = []
    for _ in range(max(0, n - 1)):
        slen = u30()
        strs.append(abc[p : p + slen].decode("utf-8", "ignore"))
        p += slen
    return strs


def convert_swf(swf_path: str, out_dir: str, lesson_id: str = "", part_id: str = ""):
    os.makedirs(os.path.join(out_dir, "assets", "images"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "assets", "shapes"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "assets", "audio"), exist_ok=True)

    raw = open(swf_path, "rb").read()
    sig = raw[:3]
    if sig == b"CWS":
        body = zlib.decompress(raw[8:])
    elif sig == b"FWS":
        body = raw[8:]
    else:
        raise ValueError(f"Unsupported SWF signature {sig} in {swf_path}")

    br = BitReader(body)
    stage_rect = read_rect(br)
    fps = br.read_u16() / 256.0
    _total_frames = br.read_u16()
    pos = br.byte_pos

    bg_color = "#ffffff"
    images_meta = {}
    shapes_meta = {}
    morphs_meta = {}
    fonts = {}
    texts_meta = {}
    sounds_meta = {}
    buttons_meta = {}
    sprites_meta = {}
    symbol_classes = {}
    abc_strings = []
    root_tags = []

    all_tags = []
    while pos + 2 <= len(body):
        th = struct.unpack_from("<H", body, pos)[0]
        pos += 2
        tid = th >> 6
        tlen = th & 0x3F
        if tlen == 0x3F:
            tlen = struct.unpack_from("<I", body, pos)[0]
            pos += 4
        data = body[pos : pos + tlen]
        pos += tlen
        if tid == 0:
            break
        all_tags.append((tid, data))

    # Pass 1: Extract images & fonts first so shapes/texts never miss an image or font definition
    for tid, data in all_tags:
        if tid == 9:
            bg_color = f"#{data[0]:02x}{data[1]:02x}{data[2]:02x}"
        elif tid in (20, 36):
            cid, _fmt, w, h = struct.unpack_from("<HBHH", data, 0)
            fname = f"img_{cid}.png"
            out_img = os.path.join(out_dir, "assets", "images", fname)
            if not os.path.exists(out_img):
                png_bytes, w, h = decode_lossless_to_png(data, tid == 36)
                open(out_img, "wb").write(png_bytes)
            images_meta[cid] = {"file": fname, "w": w, "h": h}
        elif tid == 35:
            cid = struct.unpack_from("<H", data, 0)[0]
            img_bytes, ext, w, h = decode_jpeg3_to_image(data)
            fname = f"img_{cid}.{ext}"
            open(os.path.join(out_dir, "assets", "images", fname), "wb").write(img_bytes)
            images_meta[cid] = {"file": fname, "w": w, "h": h}
        elif tid == 21:
            cid = struct.unpack_from("<H", data, 0)[0]
            jpeg_data = data[2:].replace(b"\xff\xd9\xff\xd8", b"")
            w, h = 100, 100
            if Image is not None:
                try:
                    im = Image.open(io.BytesIO(jpeg_data))
                    w, h = im.size
                except Exception:
                    pass
            fname = f"img_{cid}.jpg"
            open(os.path.join(out_dir, "assets", "images", fname), "wb").write(jpeg_data)
            images_meta[cid] = {"file": fname, "w": w, "h": h}
        elif tid == 75:
            fid, glyphs = parse_font3(data)
            fonts[fid] = glyphs

    # Pass 2: Extract shapes, morph shapes, texts, sounds, buttons, sprites, symbols, and root timeline
    for tid, data in all_tags:
        if tid in (9, 20, 21, 35, 36, 75):
            continue
        elif tid in (2, 22, 32, 83):
            ver = {2: 1, 22: 2, 32: 3, 83: 4}[tid]
            sid, svg, bounds = shape_to_svg(data, ver, images_meta)
            fname = f"shape_{sid}.svg"
            open(os.path.join(out_dir, "assets", "shapes", fname), "w", encoding="utf-8").write(svg)
            shapes_meta[sid] = {"file": fname, "bounds": bounds}
        elif tid in (46, 84):
            cid, svg, eb, sb = parse_morph_to_svg(data, tid)
            fname = f"shape_{cid}.svg"
            open(os.path.join(out_dir, "assets", "shapes", fname), "w", encoding="utf-8").write(svg)
            shapes_meta[cid] = {"file": fname, "bounds": eb}
            morphs_meta[cid] = {"startBounds": sb, "endBounds": eb}
        elif tid in (11, 33):
            cid, svg, bounds = parse_define_text(data, tid == 33, fonts)
            fname = f"text_{cid}.svg"
            open(os.path.join(out_dir, "assets", "shapes", fname), "w", encoding="utf-8").write(svg)
            texts_meta[cid] = {"file": fname, "bounds": bounds}
        elif tid == 14:
            sid = struct.unpack_from("<H", data, 0)[0]
            fmt = data[2] >> 4
            if fmt == 2:
                fname = f"sound_{sid}.mp3"
                open(os.path.join(out_dir, "assets", "audio", fname), "wb").write(data[9:])
                sounds_meta[sid] = {"file": fname, "format": "mp3"}
            else:
                fname = f"sound_{sid}.bin"
                open(os.path.join(out_dir, "assets", "audio", fname), "wb").write(data[7:])
                sounds_meta[sid] = {"file": fname, "format": f"swf_{fmt}"}
        elif tid == 34:
            btn = parse_button2(data)
            buttons_meta[btn["id"]] = btn["states"]
        elif tid == 39:
            sp_id, _sp_frames = struct.unpack_from("<HH", data, 0)
            sp_tags = []
            sp_pos = 4
            while sp_pos + 2 <= len(data):
                sth = struct.unpack_from("<H", data, sp_pos)[0]
                sp_pos += 2
                stid = sth >> 6
                stlen = sth & 0x3F
                if stlen == 0x3F:
                    stlen = struct.unpack_from("<I", data, sp_pos)[0]
                    sp_pos += 4
                sp_tags.append((stid, data[sp_pos : sp_pos + stlen]))
                sp_pos += stlen
                if stid == 0:
                    break
            tl = parse_timeline(sp_tags)
            stream_file = None
            if tl["streamMp3"]:
                stream_file = f"stream_sprite_{sp_id}.mp3"
                open(os.path.join(out_dir, "assets", "audio", stream_file), "wb").write(tl["streamMp3"])
            sprites_meta[sp_id] = {
                "frameCount": tl["frameCount"],
                "frames": tl["frames"],
                "streamAudio": stream_file,
            }
        elif tid == 76:
            cnt = struct.unpack_from("<H", data, 0)[0]
            sp = 2
            for _ in range(cnt):
                cid = struct.unpack_from("<H", data, sp)[0]
                sp += 2
                end = data.find(b"\x00", sp)
                cname = data[sp:end].decode("utf-8", "ignore")
                sp = end + 1
                symbol_classes[cname] = cid
        elif tid == 82:
            abc_strings.extend(extract_abc_strings(data))
        else:
            root_tags.append((tid, data))

    root_tl = parse_timeline(root_tags)
    if root_tl["streamMp3"]:
        open(os.path.join(out_dir, "assets", "audio", "stream_root.mp3"), "wb").write(root_tl["streamMp3"])

    scene = {
        "width": stage_rect[2] - stage_rect[0],
        "height": stage_rect[3] - stage_rect[1],
        "fps": fps,
        "bgColor": bg_color,
        "images": images_meta,
        "shapes": shapes_meta,
        "morphs": morphs_meta,
        "texts": texts_meta,
        "sounds": sounds_meta,
        "buttons": buttons_meta,
        "sprites": sprites_meta,
        "root": {
            "frameCount": root_tl["frameCount"],
            "frames": root_tl["frames"],
            "streamAudio": "stream_root.mp3" if root_tl["streamMp3"] else None,
        },
        "symbols": symbol_classes,
    }
    open(os.path.join(out_dir, "scene.json"), "w", encoding="utf-8").write(
        json.dumps(scene, ensure_ascii=False, separators=(",", ":"))
    )

    lesson = build_lesson_config(lesson_id, part_id, scene, abc_strings)
    open(os.path.join(out_dir, "lesson.json"), "w", encoding="utf-8").write(
        json.dumps(lesson, ensure_ascii=False, indent=2)
    )
    return scene, lesson


def build_lesson_config(lesson_id: str, part_id: str, scene: dict, abc_strings: list[str]) -> dict:
    named_instances = set()
    for fr in scene["root"]["frames"]:
        for act in fr["actions"]:
            if act.get("name"):
                named_instances.add(act["name"])
    for sp in scene["sprites"].values():
        for fr in sp["frames"]:
            for act in fr["actions"]:
                if act.get("name"):
                    named_instances.add(act["name"])

    s_set = set(abc_strings)
    if part_id == "1" or "controller" in s_set:
        mode = "animation"
    elif "anStartDrag" in s_set or "onDrag" in s_set or "hitObj" in s_set or "zbx" in s_set:
        mode = "interactive_drag"
    else:
        mode = "interactive_quiz"

    main_sprite_id = None
    max_frames = 0
    for sid, sp in scene["sprites"].items():
        if sp["frameCount"] > max_frames:
            max_frames = sp["frameCount"]
            main_sprite_id = sid

    audio_map = {}
    for cname, cid in scene["symbols"].items():
        if cid in scene["sounds"]:
            audio_map[cname] = scene["sounds"][cid]["file"]

    return {
        "lesson": lesson_id,
        "part": part_id,
        "title": f"第{lesson_id}课 - 部分{part_id}" if lesson_id else "UI",
        "mode": mode,
        "fps": scene["fps"],
        "width": scene["width"],
        "height": scene["height"],
        "mainSpriteId": main_sprite_id,
        "totalFrames": max_frames if mode == "animation" else scene["root"]["frameCount"],
        "audio": audio_map,
        "controls": {
            "hasPrevNext": ("Left" in named_instances or "Right" in named_instances),
            "hasHelp": ("help_btn" in named_instances or "tips_btn" in named_instances or "help_mc" in named_instances),
            "hasEndScreen": ("end_mc" in named_instances),
            "hasReset": ("reset" in s_set or "onReset" in s_set),
        },
        "namedInstances": sorted(named_instances),
    }


if __name__ == "__main__":
    import sys
    convert_swf(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "", sys.argv[4] if len(sys.argv) > 4 else "")
