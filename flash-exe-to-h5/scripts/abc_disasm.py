#!/usr/bin/env python3
"""
AVM2 (DoABC2) Bytecode Disassembler for SWF files.
"""
import struct
import zlib

# AVM2 opcodes: (name, operand_types)
# operand types: u30, s24, u8, s8, m (multiname u30), s (string u30), i (int u30), d (double u30), method (u30)
OPCODES = {
    0x02: ("nop", ()),
    0x03: ("throw", ()),
    0x04: ("getsuper", ("m",)),
    0x05: ("setsuper", ("m",)),
    0x08: ("kill", ("u30",)),
    0x09: ("label", ()),
    0x0C: ("ifnlt", ("s24",)),
    0x0D: ("ifnle", ("s24",)),
    0x0E: ("ifngt", ("s24",)),
    0x0F: ("ifnge", ("s24",)),
    0x10: ("jump", ("s24",)),
    0x11: ("iftrue", ("s24",)),
    0x12: ("iffalse", ("s24",)),
    0x13: ("ifeq", ("s24",)),
    0x14: ("ifne", ("s24",)),
    0x15: ("iflt", ("s24",)),
    0x16: ("ifle", ("s24",)),
    0x17: ("ifgt", ("s24",)),
    0x18: ("ifge", ("s24",)),
    0x19: ("ifstricteq", ("s24",)),
    0x1A: ("ifstrictne", ("s24",)),
    0x1B: ("lookupswitch", ("switch",)),
    0x1C: ("pushwith", ()),
    0x1D: ("popscope", ()),
    0x1E: ("nextname", ()),
    0x20: ("pushnull", ()),
    0x21: ("pushundefined", ()),
    0x23: ("nextvalue", ()),
    0x24: ("pushbyte", ("s8",)),
    0x25: ("pushshort", ("u30",)),
    0x26: ("pushtrue", ()),
    0x27: ("pushfalse", ()),
    0x28: ("pushnan", ()),
    0x29: ("pop", ()),
    0x2A: ("dup", ()),
    0x2B: ("swap", ()),
    0x2C: ("pushstring", ("s",)),
    0x2D: ("pushint", ("i",)),
    0x2E: ("pushuint", ("u30",)),
    0x2F: ("pushdouble", ("d",)),
    0x30: ("pushscope", ()),
    0x31: ("pushnamespace", ("u30",)),
    0x32: ("hasnext2", ("u30", "u30")),
    0x40: ("newfunction", ("u30",)),
    0x41: ("call", ("u30",)),
    0x42: ("construct", ("u30",)),
    0x43: ("callmethod", ("u30", "u30")),
    0x44: ("callstatic", ("u30", "u30")),
    0x45: ("callsuper", ("m", "u30")),
    0x46: ("callproperty", ("m", "u30")),
    0x47: ("returnvoid", ()),
    0x48: ("returnvalue", ()),
    0x49: ("constructsuper", ("u30",)),
    0x4A: ("constructprop", ("m", "u30")),
    0x4C: ("callproplex", ("m", "u30")),
    0x4E: ("callsupervoid", ("m", "u30")),
    0x4F: ("callpropvoid", ("m", "u30")),
    0x53: ("applytype", ("u30",)),
    0x55: ("newobject", ("u30",)),
    0x56: ("newarray", ("u30",)),
    0x57: ("newactivation", ()),
    0x58: ("newclass", ("u30",)),
    0x59: ("getdescendants", ("m",)),
    0x5A: ("newcatch", ("u30",)),
    0x5D: ("findpropstrict", ("m",)),
    0x5E: ("findproperty", ("m",)),
    0x5F: ("finddef", ("m",)),
    0x60: ("getlex", ("m",)),
    0x61: ("setproperty", ("m",)),
    0x62: ("getlocal", ("u30",)),
    0x63: ("setlocal", ("u30",)),
    0x64: ("getglobalscope", ()),
    0x65: ("getscopeobject", ("u8",)),
    0x66: ("getproperty", ("m",)),
    0x68: ("initproperty", ("m",)),
    0x6A: ("deleteproperty", ("m",)),
    0x6C: ("getslot", ("u30",)),
    0x6D: ("setslot", ("u30",)),
    0x70: ("convert_s", ()),
    0x73: ("convert_i", ()),
    0x74: ("convert_u", ()),
    0x75: ("convert_d", ()),
    0x76: ("convert_b", ()),
    0x80: ("coerce", ("m",)),
    0x82: ("coerce_a", ()),
    0x85: ("coerce_s", ()),
    0x86: ("astype", ("m",)),
    0x87: ("astypelate", ()),
    0x90: ("negate", ()),
    0x91: ("increment", ()),
    0x92: ("inclocal", ("u30",)),
    0x93: ("decrement", ()),
    0x94: ("declocal", ("u30",)),
    0x95: ("typeof", ()),
    0x96: ("not", ()),
    0x97: ("bitnot", ()),
    0xA0: ("add", ()),
    0xA1: ("subtract", ()),
    0xA2: ("multiply", ()),
    0xA3: ("divide", ()),
    0xA4: ("modulo", ()),
    0xA5: ("lshift", ()),
    0xA6: ("rshift", ()),
    0xA7: ("urshift", ()),
    0xA8: ("bitand", ()),
    0xA9: ("bitor", ()),
    0xAA: ("bitxor", ()),
    0xAB: ("equals", ()),
    0xAC: ("strictequals", ()),
    0xAD: ("lessthan", ()),
    0xAE: ("lessequals", ()),
    0xAF: ("greaterthan", ()),
    0xB0: ("greaterequals", ()),
    0xB1: ("instanceof", ()),
    0xB2: ("istype", ("m",)),
    0xB3: ("istypelate", ()),
    0xB4: ("in", ()),
    0xC0: ("increment_i", ()),
    0xC1: ("decrement_i", ()),
    0xC2: ("inclocal_i", ("u30",)),
    0xC3: ("declocal_i", ("u30",)),
    0xC5: ("add_i", ()),
    0xC6: ("subtract_i", ()),
    0xD0: ("getlocal_0", ()),
    0xD1: ("getlocal_1", ()),
    0xD2: ("getlocal_2", ()),
    0xD3: ("getlocal_3", ()),
    0xD4: ("setlocal_0", ()),
    0xD5: ("setlocal_1", ()),
    0xD6: ("setlocal_2", ()),
    0xD7: ("setlocal_3", ()),
    0xEF: ("debug", ("u8", "s", "u8", "u30")),
    0xF0: ("debugline", ("u30",)),
    0xF1: ("debugfile", ("s",)),
}


class AbcReader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def u8(self):
        v = self.data[self.pos]
        self.pos += 1
        return v

    def s8(self):
        v = struct.unpack_from("b", self.data, self.pos)[0]
        self.pos += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.data, self.pos)[0]
        self.pos += 2
        return v

    def s24(self):
        b0, b1, b2 = self.data[self.pos : self.pos + 3]
        self.pos += 3
        v = b0 | (b1 << 8) | (b2 << 16)
        if v & 0x800000:
            v -= 0x1000000
        return v

    def u30(self):
        res = 0
        shift = 0
        while True:
            b = self.data[self.pos]
            self.pos += 1
            res |= (b & 0x7F) << shift
            if not (b & 0x80):
                return res
            shift += 7

    def s32(self):
        v = self.u30()
        if v & 0x80000000:
            v -= 0x100000000
        return v

    def d64(self):
        v = struct.unpack_from("<d", self.data, self.pos)[0]
        self.pos += 8
        return v


def parse_abc(abc_bytes: bytes):
    r = AbcReader(abc_bytes)
    _minor, _major = r.u16(), r.u16()

    ints = [0] + [r.s32() for _ in range(max(0, r.u30() - 1))]
    uints = [0] + [r.u30() for _ in range(max(0, r.u30() - 1))]
    doubles = [0.0] + [r.d64() for _ in range(max(0, r.u30() - 1))]

    strings = [""]
    for _ in range(max(0, r.u30() - 1)):
        ln = r.u30()
        strings.append(abc_bytes[r.pos : r.pos + ln].decode("utf-8", "ignore"))
        r.pos += ln

    namespaces = [""]
    for _ in range(max(0, r.u30() - 1)):
        _kind = r.u8()
        namespaces.append(strings[r.u30()])

    for _ in range(max(0, r.u30() - 1)):
        for _ in range(r.u30()):
            r.u30()

    multinames = ["*"]
    for _ in range(max(0, r.u30() - 1)):
        kind = r.u8()
        if kind in (0x07, 0x0D):
            ns = namespaces[r.u30()]
            nm = strings[r.u30()]
            multinames.append(f"{ns}:{nm}" if ns else nm)
        elif kind in (0x0F, 0x10):
            multinames.append(strings[r.u30()])
        elif kind in (0x11, 0x12):
            multinames.append("*")
        elif kind in (0x09, 0x0E):
            nm = strings[r.u30()]
            r.u30()
            multinames.append(nm)
        elif kind in (0x1B, 0x1C):
            r.u30()
            multinames.append("[]")
        elif kind == 0x1D:
            base = multinames[r.u30()]
            pc = r.u30()
            params = [multinames[r.u30()] for _ in range(pc)]
            multinames.append(f"{base}.<{','.join(params)}>")

    for _ in range(r.u30()):
        pc = r.u30()
        r.u30()
        for _ in range(pc):
            r.u30()
        r.u30()
        flags = r.u8()
        if flags & 0x08:
            for _ in range(r.u30()):
                r.u30()
                r.u8()
        if flags & 0x80:
            for _ in range(pc):
                r.u30()

    for _ in range(r.u30()):
        r.u30()
        for _ in range(r.u30() * 2):
            r.u30()

    def read_traits():
        traits = []
        for _ in range(r.u30()):
            tname = multinames[r.u30()]
            tag = r.u8()
            kind = tag & 0x0F
            if kind in (0, 6):
                r.u30()
                r.u30()
                vi = r.u30()
                if vi != 0:
                    r.u8()
            elif kind in (1, 2, 3):
                r.u30()
                mid = r.u30()
                traits.append(("method", tname, mid))
            elif kind in (4, 5):
                r.u30()
                r.u30()
            if tag & 0x40:
                for _ in range(r.u30()):
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
        for _ in range(r.u30()):
            r.u30()
        iinit = r.u30()
        traits = read_traits()
        instances.append({"name": cname, "super": sname, "iinit": iinit, "traits": traits})

    for _ in range(cls_cnt):
        r.u30()
        read_traits()

    for _ in range(r.u30()):
        r.u30()
        read_traits()

    bodies = {}
    for _ in range(r.u30()):
        mid = r.u30()
        r.u30(); r.u30(); r.u30(); r.u30()
        clen = r.u30()
        code = abc_bytes[r.pos : r.pos + clen]
        r.pos += clen
        for _ in range(r.u30()):
            r.u30(); r.u30(); r.u30(); r.u30(); r.u30()
        read_traits()
        bodies[mid] = code

    def disasm(code: bytes):
        cr = AbcReader(code)
        lines = []
        while cr.pos < len(code):
            off = cr.pos
            op = cr.u8()
            if op not in OPCODES:
                lines.append(f"  {off:04d}: unknown_0x{op:02x}")
                break
            oname, otypes = OPCODES[op]
            args = []
            for ot in otypes:
                if ot == "u30":
                    args.append(str(cr.u30()))
                elif ot == "u8":
                    args.append(str(cr.u8()))
                elif ot == "s8":
                    args.append(str(cr.s8()))
                elif ot == "s24":
                    d = cr.s24()
                    args.append(f"->{cr.pos + d:04d}")
                elif ot == "m":
                    args.append(multinames[cr.u30()])
                elif ot == "s":
                    args.append(repr(strings[cr.u30()]))
                elif ot == "i":
                    args.append(str(ints[cr.u30()]))
                elif ot == "d":
                    args.append(str(doubles[cr.u30()]))
                elif ot == "switch":
                    d = cr.s24()
                    cnt = cr.u30() + 1
                    cases = [cr.s24() for _ in range(cnt)]
                    args.append(f"default={d}, cases={len(cases)}")
            lines.append(f"  {off:04d}: {oname} {' '.join(args)}")
        return lines

    for inst in instances:
        print(f"CLASS {inst['name']} extends {inst['super']}")
        if inst["iinit"] in bodies:
            print(f"  METHOD <init> (#{inst['iinit']}):")
            for l in disasm(bodies[inst["iinit"]]):
                print("  " + l)
        for t in inst["traits"]:
            if t[0] == "method":
                _, mname, mid = t
                print(f"  METHOD {mname} (#{mid}):")
                if mid in bodies:
                    for l in disasm(bodies[mid]):
                        print("  " + l)


def dump_swf_abc(swf_path: str):
    raw = open(swf_path, "rb").read()
    body = zlib.decompress(raw[8:]) if raw[:3] == b"CWS" else raw[8:]
    nbits = body[0] >> 3
    pos = ((5 + nbits * 4 + 7) // 8) + 4
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
            parse_abc(data[p + 1 :])
        pos += tlen
        if tid == 0:
            break


if __name__ == "__main__":
    import sys
    dump_swf_abc(sys.argv[1])
