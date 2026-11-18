#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
End-to-end batch converter:
1. Extracts ActionScript 3 (.as) files from all SWFs into extracted/as/*.as (if not already done)
2. Converts Main-xiao.swf and swf/1-1.swf..16-3.swf into h5/
3. Copies .as files directly into h5/ui/ and h5/lessons/lesson-XX/Y/script.as
4. Copies the pure H5 runtime template (resources/h5_template/) into h5/

Usage:
    python convert_all.py [project_root]
"""

import json
import os
import shutil
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from swf_to_h5 import convert_swf
from extract_as import extract_all_as


def copy_tree_contents(src_dir: str, dst_dir: str):
    if not os.path.exists(src_dir):
        return
    for root, _dirs, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        target_root = dst_dir if rel == "." else os.path.join(dst_dir, rel)
        os.makedirs(target_root, exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(root, f), os.path.join(target_root, f))


def run_pipeline(project_root: str):
    t0 = time.time()
    extracted = os.path.join(project_root, "extracted")
    h5_dir = os.path.join(project_root, "h5")
    as_dir = os.path.join(extracted, "as")

    # 1. Ensure all .as files are extracted from DoABC2 tags
    extract_all_as(extracted, as_dir)

    # 2. Copy H5 runtime template (index.html, start_h5.bat, css/, js/)
    tpl_dir = os.path.join(SKILL_DIR, "resources", "h5_template")
    copy_tree_contents(tpl_dir, h5_dir)

    # 3. Copy media files (00.mp4, 2.mp3)
    os.makedirs(os.path.join(h5_dir, "media"), exist_ok=True)
    for m in ("00.mp4", "2.mp3"):
        src = os.path.join(extracted, m)
        dst = os.path.join(h5_dir, "media", m)
        if os.path.exists(src):
            shutil.copy2(src, dst)

    # 4. Convert Main-xiao.swf UI + copy Main.as & Main-xiao.as
    ui_dir = os.path.join(h5_dir, "ui")
    main_swf = os.path.join(extracted, "Main-xiao.swf")
    if os.path.exists(main_swf):
        convert_swf(main_swf, ui_dir, "", "")
    for fn in ("Main.as", "Main-xiao.as"):
        src_as = os.path.join(as_dir, fn)
        if os.path.exists(src_as):
            shutil.copy2(src_as, os.path.join(ui_dir, fn))

    # 5. Convert all 16 lessons (48 parts) and attach script.as directly
    catalog = []
    for lesson_num in range(1, 17):
        lesson_entry = {
            "id": lesson_num,
            "folder": f"lesson-{lesson_num:02d}",
            "title": f"第{lesson_num}课",
            "parts": [],
        }
        for part_num in range(1, 4):
            swf_path = os.path.join(extracted, "swf", f"{lesson_num}-{part_num}.swf")
            if not os.path.exists(swf_path):
                continue
            out_dir = os.path.join(h5_dir, "lessons", f"lesson-{lesson_num:02d}", str(part_num))
            print(f"[{lesson_num:02d}-{part_num}] Converting {os.path.basename(swf_path)}...", flush=True)
            _scene, lesson = convert_swf(swf_path, out_dir, str(lesson_num), str(part_num))

            # Copy decompiled .as directly as script.as
            src_as = os.path.join(as_dir, f"{lesson_num}-{part_num}.as")
            if os.path.exists(src_as):
                shutil.copy2(src_as, os.path.join(out_dir, "script.as"))

            lesson_entry["parts"].append({
                "part": part_num,
                "path": f"lessons/lesson-{lesson_num:02d}/{part_num}",
                "mode": lesson["mode"],
                "totalFrames": lesson["totalFrames"],
                "title": lesson["title"],
            })
        catalog.append(lesson_entry)

    catalog_path = os.path.join(h5_dir, "lessons", "catalog.json")
    os.makedirs(os.path.dirname(catalog_path), exist_ok=True)
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump({"lessons": catalog}, f, ensure_ascii=False, indent=2)

    print(f"Done! Built standalone H5 package in {h5_dir} in {time.time() - t0:.1f}s.")


if __name__ == "__main__":
    root_arg = sys.argv[1] if len(sys.argv) >= 2 else os.getcwd()
    run_pipeline(os.path.abspath(root_arg))
