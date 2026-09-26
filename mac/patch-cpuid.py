#!/usr/bin/env python3
"""Prints winedbg commands that fix the game's broken CMPXCHG8B check in memory.

The game's atomics library (gear/thread/atomic/win32/atomic.h) asserts
Private::IsCmpXchg8bSupported() before 64-bit atomic operations. The check reads
CPUID leaf 1 and tests EDX & 0x8, which is PSE (bit 3), not CX8 (bit 8). Real x86
CPUs always report PSE, so this never fails on Windows. Rosetta 2 reports CX8 but not
PSE, so the assert fires (int3 -> crash) as soon as the game logs in online.

Each check is `mov eax, 1; cpuid; and edx, 8`. The fix rewrites `and edx, 8` (83 e2 08)
to `or edx, 8` (83 ca 08), which has the same length and makes the check always pass.

The exe file itself can't be patched: the 5th-echelon shim hashes it on startup and
refuses to run a modified binary. So launch.sh starts the game under winedbg, which
applies these writes at the initial breakpoint and detaches.

With --nla, also bypass the game's Windows NLA availability probe, which fails
under Sikarugir Wine even when the game can reach the server.

Usage: patch-cpuid.py [--nla] <exe>   (prints the winedbg script to stdout)
"""
import argparse
import struct
import sys
from pathlib import Path

CHECK = bytes.fromhex("b8 01000000 0fa2 83e2 08")
OPERAND = 8  # offset of the e2 (ModRM: and edx) byte inside CHECK
OR_EDX = 0xCA  # ModRM for `or edx, imm8`

# NLAT refresh stores network/internet availability at this+0x9c / this+0xa0.
# Both shipped DX9/DX11 executables have this unique epilogue and prologue,
# separated by 0x11f bytes. Validate both before emitting any debugger writes.
NLA_STORES = bytes.fromhex("89 b7 9c000000 89 97 a0000000")
NLA_PROLOGUE = bytes.fromhex("55 8b ec b8 50000100")
NLA_STORES_OFFSET = 0x11F
# mov eax,1; mov [ecx+9c],eax; mov [ecx+a0],eax; ret
NLA_REPLACEMENT = bytes.fromhex("b8 01000000 89 81 9c000000 89 81 a0000000 c3")


def nla_offset(data: bytes) -> int:
    if data.count(NLA_STORES) != 1:
        raise ValueError("expected exactly one NLA availability probe")
    offset = data.index(NLA_STORES) - NLA_STORES_OFFSET
    if offset < 0 or data[offset:offset + len(NLA_PROLOGUE)] != NLA_PROLOGUE:
        raise ValueError("unrecognized NLA availability probe prologue")
    return offset


def file_offset_to_va(data: bytes):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    sections, opt_size = struct.unpack_from("<H", data, pe + 6)[0], struct.unpack_from("<H", data, pe + 20)[0]
    image_base = struct.unpack_from("<I", data, pe + 24 + 28)[0]
    table = []
    for i in range(sections):
        entry = pe + 24 + opt_size + i * 40
        _vsize, va, raw_size, raw = struct.unpack_from("<IIII", data, entry + 8)
        table.append((raw, raw_size, image_base + va))

    def convert(offset: int) -> int:
        for raw, raw_size, va in table:
            if raw <= offset < raw + raw_size:
                return va + offset - raw
        raise ValueError(f"offset {offset:#x} is outside every section")

    return convert


def main(exe: Path, nla: bool = False) -> None:
    data = exe.read_bytes()
    to_va = file_offset_to_va(data)
    offsets = []
    start = data.find(CHECK)
    while start != -1:
        offsets.append(start)
        start = data.find(CHECK, start + 1)
    if not offsets:
        sys.exit(f"{exe.name}: no CMPXCHG8B checks found")
    # Resolve and validate all writes before printing commands. A failed match
    # must not leave a partially patched game running.
    writes = [(to_va(offset + OPERAND), OR_EDX) for offset in offsets]
    if nla:
        start = nla_offset(data)
        writes.extend((to_va(start + i), byte) for i, byte in enumerate(NLA_REPLACEMENT))
    for address, byte in writes:
        print(f"set *(unsigned char*){address:#x} = {byte:#x}")
    print("detach")
    print("quit")
    print(f"{exe.name}: {len(offsets)} CMPXCHG8B checks", file=sys.stderr)
    if nla:
        print(f"{exe.name}: Wine NLA workaround at {to_va(start):#x}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nla", action="store_true", help="bypass Wine's failing NLA availability probe")
    parser.add_argument("exe", type=Path)
    args = parser.parse_args()
    main(args.exe, args.nla)
