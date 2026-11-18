#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Step 1: Unpack Enigma Virtual Box (EVB\x00) virtual file system and/or trailing
0xFA123456 Flash Projector SWF from a Windows .exe into extracted/.

Usage:
    python unpack_evb.py <path/to/bundle.exe> [output_extracted_dir]
"""

import os
import struct
import sys


def find_evb_offset(f, file_size: int) -> int:
    f.seek(0)
    hdr = f.read(4096)
    if hdr[:2] == b"MZ":
        pe_off = struct.unpack_from("<I", hdr, 0x3C)[0]
        if pe_off + 24 < len(hdr) and hdr[pe_off : pe_off + 4] == b"PE\x00\x00":
            num_sec = struct.unpack_from("<H", hdr, pe_off + 6)[0]
            opt_sz = struct.unpack_from("<H", hdr, pe_off + 20)[0]
            sec_off = pe_off + 24 + opt_sz
            for i in range(num_sec):
                off = sec_off + i * 40
                name = hdr[off : off + 8].rstrip(b"\x00").decode("latin1", "replace")
                vsize, vaddr, rsize, raddr = struct.unpack_from("<IIII", hdr, off + 8)
                if name.startswith(".enigma"):
                    f.seek(raddr)
                    probe = f.read(min(rsize, 1024 * 1024))
                    idx = probe.find(b"EVB\x00")
                    if idx >= 0:
                        return raddr + idx
    # Fallback: scan first 16 MB in 1 MB chunks
    f.seek(0)
    scanned = 0
    while scanned < min(file_size, 16 * 1024 * 1024):
        chunk = f.read(1024 * 1024)
        if not chunk:
            break
        idx = chunk.find(b"EVB\x00")
        if idx >= 0:
            return scanned + idx
        scanned += len(chunk)
    return -1


def unpack_exe(exe_path: str, out_root: str):
    file_size = os.path.getsize(exe_path)
    os.makedirs(out_root, exist_ok=True)

    with open(exe_path, "rb") as f:
        # 1. Check trailing Flash Projector SWF (magic 0xFA123456)
        if file_size > 8:
            f.seek(file_size - 8)
            magic, swf_len = struct.unpack("<II", f.read(8))
            if magic == 0xFA123456 and 0 < swf_len < file_size - 8:
                f.seek(file_size - 8 - swf_len)
                proj_data = f.read(swf_len)
                proj_out = os.path.join(out_root, "_projector_main.swf")
                with open(proj_out, "wb") as pf:
                    pf.write(proj_data)
                print(f"[Projector] Extracted trailing SWF ({swf_len} bytes) -> {proj_out}")

        # 2. Check EVB\x00 virtual file system
        evb_off = find_evb_offset(f, file_size)
        if evb_off < 0:
            print("[EVB] No EVB\\x00 signature found.")
            return

        f.seek(evb_off)
        evb_hdr = f.read(0x44)
        tree_sz = struct.unpack_from("<I", evb_hdr, 0x40)[0]
        tree = f.read(tree_sz)
        data_off = evb_off + 0x44 + tree_sz

        files = []

        def read_node(pos: int, rel_dir: str = "") -> int:
            nid, level, nchild = struct.unpack_from("<III", tree, pos)
            pos += 12
            end = pos
            while end + 1 < len(tree):
                if tree[end] == 0 and tree[end + 1] == 0:
                    break
                end += 2
            name = tree[pos:end].decode("utf-16-le", "replace")
            pos = end + 2
            ntype = tree[pos]
            pos += 1
            if ntype == 3:  # Folder
                pos += 29
                sub = "" if name == "%DEFAULT FOLDER%" else os.path.join(rel_dir, name)
                for _ in range(nchild):
                    pos = read_node(pos, sub)
            elif ntype == 2:  # File
                orig_sz = struct.unpack_from("<Q", tree, pos + 2)[0]
                rel_path = os.path.join(rel_dir, name) if rel_dir else name
                files.append((nid, rel_path, orig_sz))
                if pos + 57 < len(tree):
                    n1 = struct.unpack_from("<I", tree, pos + 57)[0]
                    n2 = struct.unpack_from("<I", tree, pos + 58)[0] if pos + 58 + 4 <= len(tree) else -1
                    pos += 57 if n1 == nid + 1 else 58
                else:
                    pos = len(tree)
            else:
                raise ValueError(f"Unknown EVB node type {ntype} at {pos - 1}")
            return pos

        read_node(15)
        cur = data_off
        for _nid, rel_path, sz in files:
            dst = os.path.join(out_root, rel_path)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            f.seek(cur)
            buf = f.read(sz)
            with open(dst, "wb") as out:
                out.write(buf)
            cur += sz
        print(f"[EVB] Extracted {len(files)} files ({cur - data_off} bytes) -> {out_root}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python unpack_evb.py <bundle.exe> [extracted_dir]")
        sys.exit(1)
    exe_file = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(os.path.dirname(os.path.abspath(exe_file)), "extracted")
    unpack_exe(exe_file, out_dir)
