#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Extract ActionScript 3 (.as) design logic from DoABC2 tags in all extracted SWFs
into extracted/as/*.as (and copy extracted/Main.as into extracted/as/Main.as).
"""

import os
import shutil
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, r"c:\Users\13301\Desktop\flash-exe-to-h5\scripts")
from abc_disasm import AbcReader, OPCODES

# Add applytype (0x53) if missing
OPCODES_EXT = dict(OPCODES)
OPCODES_EXT[0x53] = ("applytype", ("u30",))


def clean_qname(name: str) -> str:
    if ":" in name:
        ns, short = name.rsplit(":", 1)
        return short
    return name


def parse_abc_full(abc: bytes):
    r = AbcReader(abc)
    _minor = r.u16()
    _major = r.u16()

    ints = [0] + [r.s32() for _ in range(max(0, r.u30() - 1))]
    uints = [0] + [r.u30() for _ in range(max(0, r.u30() - 1))]
    doubles = [0.0] + [r.d64() for _ in range(max(0, r.u30() - 1))]
    strings = [""]
    for _ in range(max(0, r.u30() - 1)):
        ln = r.u30()
        strings.append(abc[r.pos : r.pos + ln].decode("utf-8", "ignore"))
        r.pos += ln

    ns_cnt = r.u30()
    namespaces = [""]
    for _ in range(max(0, ns_cnt - 1)):
        _kind = r.u8()
        namespaces.append(strings[r.u30()])

    nss_cnt = r.u30()
    for _ in range(max(0, nss_cnt - 1)):
        c = r.u30()
        for _ in range(c):
            r.u30()

    mn_cnt = r.u30()
    multinames = ["*"]
    for _ in range(max(0, mn_cnt - 1)):
        kind = r.u8()
        if kind in (0x07, 0x0D):
            ns_i = r.u30()
            nm_i = r.u30()
            ns = namespaces[ns_i] if ns_i < len(namespaces) else ""
            nm = strings[nm_i] if nm_i < len(strings) else ""
            multinames.append(f"{ns}:{nm}" if ns else nm)
        elif kind in (0x0F, 0x10):
            multinames.append(strings[r.u30()])
        elif kind in (0x11, 0x12):
            multinames.append("*")
        elif kind in (0x09, 0x0E):
            nm = strings[r.u30()]
            _nss = r.u30()
            multinames.append(nm)
        elif kind in (0x1B, 0x1C):
            _nss = r.u30()
            multinames.append("[]")
        elif kind == 0x1D:
            base = multinames[r.u30()]
            pc = r.u30()
            params = [multinames[r.u30()] for _ in range(pc)]
            multinames.append(f"{base}.<{', '.join(clean_qname(p) for p in params)}>")
        else:
            multinames.append(f"mn_kind_{kind}")

    # Methods
    m_cnt = r.u30()
    methods = []
    for _ in range(m_cnt):
        pc = r.u30()
        ret_idx = r.u30()
        ret_type = clean_qname(multinames[ret_idx]) if ret_idx < len(multinames) and ret_idx != 0 else "*"
        ptypes = []
        for _ in range(pc):
            ti = r.u30()
            ptypes.append(clean_qname(multinames[ti]) if ti < len(multinames) and ti != 0 else "*")
        name_i = r.u30()
        mname = strings[name_i] if name_i < len(strings) else ""
        flags = r.u8()
        if flags & 0x08:
            oc = r.u30()
            for _ in range(oc):
                r.u30()
                r.u8()
        pnames = [f"param{i+1}" for i in range(pc)]
        if flags & 0x80:
            pnames = [strings[r.u30()] or f"param{i+1}" for i in range(pc)]
        methods.append({
            "params": list(zip(pnames, ptypes)),
            "ret": ret_type,
            "name": mname,
        })

    # Metadata
    meta_cnt = r.u30()
    for _ in range(meta_cnt):
        r.u30()
        ic = r.u30()
        for _ in range(ic * 2):
            r.u30()

    def read_traits():
        tc = r.u30()
        traits = []
        for _ in range(tc):
            tname = multinames[r.u30()]
            tag = r.u8()
            kind = tag & 0x0F
            if kind in (0, 6):  # slot, const
                slot_id = r.u30()
                type_idx = r.u30()
                vindex = r.u30()
                vkind = r.u8() if vindex != 0 else 0
                t_str = clean_qname(multinames[type_idx]) if type_idx != 0 and type_idx < len(multinames) else "*"
                traits.append(("const" if kind == 6 else "slot", clean_qname(tname), t_str, slot_id))
            elif kind in (1, 2, 3):  # method, getter, setter
                _disp = r.u30()
                mid = r.u30()
                kname = {1: "method", 2: "getter", 3: "setter"}[kind]
                traits.append((kname, clean_qname(tname), mid))
            elif kind == 4:  # class
                _slot = r.u30()
                cid = r.u30()
                traits.append(("class", clean_qname(tname), cid))
            elif kind == 5:  # function
                _slot = r.u30()
                fid = r.u30()
                traits.append(("function", clean_qname(tname), fid))
            if tag & 0x40:
                mc = r.u30()
                for _ in range(mc):
                    r.u30()
        return traits

    cls_cnt = r.u30()
    instances = []
    for _ in range(cls_cnt):
        cname = multinames[r.u30()]
        sname = multinames[r.u30()]
        cflags = r.u8()
        if cflags & 0x08:
            r.u30()
        icnt = r.u30()
        ifaces = [multinames[r.u30()] for _ in range(icnt)]
        iinit = r.u30()
        traits = read_traits()
        instances.append({
            "name": cname,
            "super": sname,
            "ifaces": ifaces,
            "iinit": iinit,
            "traits": traits,
        })

    for _ in range(cls_cnt):
        _cinit = r.u30()
        _ctraits = read_traits()

    sc_cnt = r.u30()
    for _ in range(sc_cnt):
        _sinit = r.u30()
        _straits = read_traits()

    mb_cnt = r.u30()
    bodies = {}
    for _ in range(mb_cnt):
        mid = r.u30()
        _max_stack = r.u30()
        local_cnt = r.u30()
        _init_scope = r.u30()
        _max_scope = r.u30()
        code_len = r.u30()
        code = abc[r.pos : r.pos + code_len]
        r.pos += code_len
        exc_cnt = r.u30()
        for _ in range(exc_cnt):
            r.u30(); r.u30(); r.u30(); r.u30(); r.u30()
        _btraits = read_traits()
        bodies[mid] = {"code": code, "local_cnt": local_cnt}

    def decode_insns(code: bytes):
        cr = AbcReader(code)
        insns = []
        while cr.pos < len(code):
            off = cr.pos
            op = cr.u8()
            if op not in OPCODES_EXT:
                insns.append((off, f"op_0x{op:02x}", []))
                break
            oname, otypes = OPCODES_EXT[op]
            args = []
            for ot in otypes:
                if ot == "u30":
                    args.append(cr.u30())
                elif ot == "u8":
                    args.append(cr.u8())
                elif ot == "s8":
                    args.append(cr.s8())
                elif ot == "s24":
                    d = cr.s24()
                    args.append(cr.pos + d)
                elif ot == "m":
                    args.append(multinames[cr.u30()])
                elif ot == "s":
                    args.append(strings[cr.u30()])
                elif ot == "i":
                    args.append(ints[cr.u30()])
                elif ot == "d":
                    args.append(doubles[cr.u30()])
                elif ot == "switch":
                    d = cr.s24()
                    cnt = cr.u30() + 1
                    cases = [cr.s24() for _ in range(cnt)]
                    args.append((off + d, [off + c for c in cases]))
            insns.append((off, oname, args))
        return insns

    return methods, instances, bodies, decode_insns


def decompile_method(insns, param_names, slots_by_id=None):
    """Best-effort stack-based AS3 decompiler for readable design-logic .as output."""
    if not insns:
        return ["// empty"]

    # Map offset -> index
    off_to_idx = {off: i for i, (off, _, _) in enumerate(insns)}
    targets = set()
    for _, op, args in insns:
        if op.startswith("if") or op == "jump":
            targets.add(args[0])
        elif op == "lookupswitch":
            d_t, c_ts = args[0]
            targets.add(d_t)
            targets.update(c_ts)

    def local_name(idx):
        if idx == 0:
            return "this"
        if 1 <= idx <= len(param_names):
            return param_names[idx - 1]
        return f"loc{idx}"

    def fmt_prop(obj, prop):
        p = clean_qname(prop)
        if obj in ("this", "global", ""):
            return p
        if p == "[]":
            return f"{obj}[/*idx*/]"
        return f"{obj}.{p}"

    stack = []
    stmts = []

    def pop():
        return stack.pop() if stack else "/*?*/"

    def popn(n):
        res = [pop() for _ in range(n)]
        res.reverse()
        return res

    BINOPS = {
        "add": "+", "add_i": "+", "subtract": "-", "subtract_i": "-", "multiply": "*", "multiply_i": "*", "divide": "/", "modulo": "%",
        "equals": "==", "strictequals": "===", "lessthan": "<", "lessequals": "<=",
        "greaterthan": ">", "greaterequals": ">=", "bitand": "&", "bitor": "|",
        "bitxor": "^", "lshift": "<<", "rshift": ">>", "urshift": ">>>",
        "istypelate": "is", "astypelate": "as",
    }

    JUMP_INV = {
        "ifeq": "!=", "ifne": "==", "iflt": ">=", "ifle": ">",
        "ifgt": "<=", "ifge": "<", "ifstricteq": "!==", "ifstrictne": "===",
        "ifnlt": "<", "ifnle": "<=", "ifngt": ">", "ifnge": ">=",
    }

    for i, (off, op, args) in enumerate(insns):
        if off in targets:
            stmts.append(f"L_{off:04d}:")

        if op == "pushscope" or op == "popscope" or op == "label" or op == "kill" or op == "nop":
            if op == "pushscope" and stack:
                stack.pop()
            continue
        elif op == "getlocal_0":
            stack.append("this")
        elif op == "getlocal_1":
            stack.append(local_name(1))
        elif op == "getlocal_2":
            stack.append(local_name(2))
        elif op == "getlocal_3":
            stack.append(local_name(3))
        elif op == "getlocal":
            stack.append(local_name(args[0]))
        elif op == "setlocal_1":
            stmts.append(f"{local_name(1)} = {pop()};")
        elif op == "setlocal_2":
            stmts.append(f"{local_name(2)} = {pop()};")
        elif op == "setlocal_3":
            stmts.append(f"{local_name(3)} = {pop()};")
        elif op == "setlocal":
            stmts.append(f"{local_name(args[0])} = {pop()};")
        elif op in ("pushbyte", "pushshort", "pushint", "pushuint", "pushdouble"):
            stack.append(str(args[0]))
        elif op == "pushstring":
            s = str(args[0]).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
            stack.append(f'"{s}"')
        elif op == "pushtrue":
            stack.append("true")
        elif op == "pushfalse":
            stack.append("false")
        elif op == "pushnull":
            stack.append("null")
        elif op == "pushundefined":
            stack.append("undefined")
        elif op == "pushnan":
            stack.append("NaN")
        elif op == "dup":
            v = stack[-1] if stack else "/*?*/"
            stack.append(v)
        elif op == "pop":
            v = pop()
            if v != "this" and not v.startswith("/*"):
                stmts.append(f"{v};")
        elif op == "swap":
            if len(stack) >= 2:
                stack[-1], stack[-2] = stack[-2], stack[-1]
        elif op in ("findpropstrict", "findproperty"):
            stack.append("global")
        elif op == "getlex":
            stack.append(clean_qname(args[0]))
        elif op == "getproperty":
            prop = args[0]
            if prop == "[]":
                idx = pop()
                obj = pop()
                stack.append(f"{obj}[{idx}]")
            else:
                obj = pop()
                stack.append(fmt_prop(obj, prop))
        elif op in ("setproperty", "initproperty"):
            prop = args[0]
            val = pop()
            if prop == "[]":
                idx = pop()
                obj = pop()
                stmts.append(f"{obj}[{idx}] = {val};")
            else:
                obj = pop()
                stmts.append(f"{fmt_prop(obj, prop)} = {val};")
        elif op == "deleteproperty":
            obj = pop()
            stmts.append(f"delete {fmt_prop(obj, args[0])};")
        elif op == "callproperty":
            prop, argc = args
            cargs = popn(argc)
            obj = pop()
            stack.append(f"{fmt_prop(obj, prop)}({', '.join(cargs)})")
        elif op == "callpropvoid":
            prop, argc = args
            cargs = popn(argc)
            obj = pop()
            stmts.append(f"{fmt_prop(obj, prop)}({', '.join(cargs)});")
        elif op == "callsuper":
            prop, argc = args
            cargs = popn(argc)
            _obj = pop()
            stack.append(f"super.{clean_qname(prop)}({', '.join(cargs)})")
        elif op == "callsupervoid":
            prop, argc = args
            cargs = popn(argc)
            _obj = pop()
            stmts.append(f"super.{clean_qname(prop)}({', '.join(cargs)});")
        elif op == "constructprop":
            prop, argc = args
            cargs = popn(argc)
            _obj = pop()
            stack.append(f"new {clean_qname(prop)}({', '.join(cargs)})")
        elif op == "constructsuper":
            cargs = popn(args[0])
            _obj = pop()
            if cargs:
                stmts.append(f"super({', '.join(cargs)});")
        elif op == "newarray":
            elems = popn(args[0])
            stack.append(f"[{', '.join(elems)}]")
        elif op == "newobject":
            pairs = []
            for _ in range(args[0]):
                v = pop()
                k = pop()
                pairs.append(f"{k}: {v}")
            pairs.reverse()
            stack.append("{" + ", ".join(pairs) + "}")
        elif op == "applytype":
            targs = popn(args[0])
            base = pop()
            stack.append(f"{base}.<{', '.join(targs)}>")
        elif op in BINOPS:
            b = pop()
            a = pop()
            stack.append(f"({a} {BINOPS[op]} {b})")
        elif op == "not":
            stack.append(f"!({pop()})")
        elif op == "negate":
            stack.append(f"-({pop()})")
        elif op in ("increment", "increment_i"):
            stack.append(f"({pop()} + 1)")
        elif op in ("decrement", "decrement_i"):
            stack.append(f"({pop()} - 1)")
        elif op == "inclocal_i" or op == "inclocal":
            stmts.append(f"{local_name(args[0])}++;")
        elif op in ("coerce", "coerce_a", "coerce_s", "convert_b", "convert_i", "convert_u", "convert_d", "convert_s"):
            pass
        elif op == "hasnext2":
            r1, r2 = args
            stack.append(f"hasNext({local_name(r1)}, {local_name(r2)})")
        elif op == "nextvalue":
            idx = pop()
            obj = pop()
            stack.append(f"{obj}[{idx}]")
        elif op == "nextname":
            idx = pop()
            obj = pop()
            stack.append(f"keyOf({obj}, {idx})")
        elif op == "iftrue":
            cond = pop()
            stmts.append(f"if ({cond}) goto L_{args[0]:04d};")
        elif op == "iffalse":
            cond = pop()
            stmts.append(f"if (!({cond})) goto L_{args[0]:04d};")
        elif op in JUMP_INV:
            b = pop()
            a = pop()
            cmp_op = {
                "ifeq": "==", "ifne": "!=", "iflt": "<", "ifle": "<=",
                "ifgt": ">", "ifge": ">=", "ifstricteq": "===", "ifstrictne": "!==",
                "ifnlt": ">=", "ifnle": ">", "ifngt": "<=", "ifnge": "<",
            }[op]
            stmts.append(f"if ({a} {cmp_op} {b}) goto L_{args[0]:04d};")
        elif op == "jump":
            stmts.append(f"goto L_{args[0]:04d};")
        elif op == "lookupswitch":
            idx = pop()
            d_t, c_ts = args[0]
            cases_str = ", ".join(f"{ci}: L_{ct:04d}" for ci, ct in enumerate(c_ts))
            stmts.append(f"switch ({idx}) {{ {cases_str}, default: L_{d_t:04d} }}")
        elif op == "returnvoid":
            if i != len(insns) - 1:
                stmts.append("return;")
        elif op == "returnvalue":
            stmts.append(f"return {pop()};")
        elif op == "throw":
            stmts.append(f"throw {pop()};")
        else:
            stmts.append(f"// {op} {args}")

    return stmts


def extract_swf_to_as(swf_path: str, out_as_path: str):
    raw = open(swf_path, "rb").read()
    body = zlib.decompress(raw[8:]) if raw[:3] == b"CWS" else raw[8:]
    nbits = body[0] >> 3
    pos = ((5 + nbits * 4 + 7) // 8) + 4
    abc_chunks = []
    while pos + 2 <= len(body):
        th = struct.unpack_from("<H", body, pos)[0]
        pos += 2
        tid = th >> 6
        tlen = th & 0x3F
        if tlen == 0x3F:
            tlen = struct.unpack_from("<I", body, pos)[0]
            pos += 4
        if tid == 82:
            data = body[pos : pos + tlen]
            p = 4
            while data[p] != 0:
                p += 1
            abc_chunks.append(data[p + 1 :])
        elif tid == 72:
            abc_chunks.append(body[pos : pos + tlen])
        pos += tlen
        if tid == 0:
            break

    lines = [f"// Extracted from {os.path.basename(swf_path)}", ""]
    for abc in abc_chunks:
        methods, instances, bodies, decode_insns = parse_abc_full(abc)
        for inst in instances:
            full_name = inst["name"]
            if ":" in full_name:
                pkg, cls_name = full_name.rsplit(":", 1)
            else:
                pkg, cls_name = "", full_name
            super_name = clean_qname(inst["super"])
            lines.append(f"package {pkg}".rstrip())
            lines.append("{")
            lines.append(f"\tpublic dynamic class {cls_name} extends {super_name}")
            lines.append("\t{")

            # Slots / constants
            for t in inst["traits"]:
                if t[0] in ("slot", "const"):
                    _, sname, stype, _sid = t
                    kw = "const" if t[0] == "const" else "var"
                    lines.append(f"\t\tpublic {kw} {sname}:{stype};")

            # Constructor
            iinit = inst["iinit"]
            if iinit in bodies:
                m = methods[iinit]
                pstr = ", ".join(f"{pn}:{pt}" for pn, pt in m["params"])
                lines.append(f"\t\tpublic function {cls_name}({pstr})")
                lines.append("\t\t{")
                insns = decode_insns(bodies[iinit]["code"])
                for st in decompile_method(insns, [pn for pn, _ in m["params"]]):
                    lines.append(f"\t\t\t{st}")
                lines.append("\t\t}")
                lines.append("")

            # Methods
            for t in inst["traits"]:
                if t[0] in ("method", "getter", "setter"):
                    kind, mname, mid = t
                    m = methods[mid]
                    pstr = ", ".join(f"{pn}:{pt}" for pn, pt in m["params"])
                    kw = "function get " if kind == "getter" else ("function set " if kind == "setter" else "function ")
                    ret = f":{m['ret']}" if m["ret"] and m["ret"] != "*" else ""
                    lines.append(f"\t\tpublic {kw}{mname}({pstr}){ret}")
                    lines.append("\t\t{")
                    if mid in bodies:
                        insns = decode_insns(bodies[mid]["code"])
                        for st in decompile_method(insns, [pn for pn, _ in m["params"]]):
                            lines.append(f"\t\t\t{st}")
                    lines.append("\t\t}")
                    lines.append("")

            lines.append("\t}")
            lines.append("}")
            lines.append("")

    os.makedirs(os.path.dirname(out_as_path), exist_ok=True)
    with open(out_as_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def extract_all_as(extracted: str, as_dir: str = ""):
    if not as_dir:
        as_dir = os.path.join(extracted, "as")
    os.makedirs(as_dir, exist_ok=True)

    # Copy original Main.as
    main_as = os.path.join(extracted, "Main.as")
    if os.path.exists(main_as):
        shutil.copy2(main_as, os.path.join(as_dir, "Main.as"))

    # Extract Main-xiao.swf
    main_swf = os.path.join(extracted, "Main-xiao.swf")
    if os.path.exists(main_swf):
        extract_swf_to_as(main_swf, os.path.join(as_dir, "Main-xiao.as"))

    # Extract all 48 lesson SWFs
    count = 1
    for i in range(1, 17):
        for j in range(1, 4):
            swf_p = os.path.join(extracted, "swf", f"{i}-{j}.swf")
            if os.path.exists(swf_p):
                out_p = os.path.join(as_dir, f"{i}-{j}.as")
                extract_swf_to_as(swf_p, out_p)
                count += 1
    print(f"Extracted {count} .as files (+ Main.as) to {as_dir}")


def main():
    extracted = sys.argv[1] if len(sys.argv) >= 2 else r"d:\pywork\hwc\extracted"
    as_dir = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(extracted, "as")
    extract_all_as(extracted, as_dir)


if __name__ == "__main__":
    main()
