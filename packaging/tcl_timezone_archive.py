"""Consolidate only an owned frozen bundle's Tcl timezone scripts, never extract."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import zlib

ORIGINAL = b'source -encoding utf-8 [file join $DataDir $fileName]'
REPLACEMENT = b'::tcl::clock::LoadArchivedTimeZone $fileName'
# Tcl 8.6.15's complete loader, normalised only for CRLF/LF platform differences.
LOADER_SHA256 = '6724c405848e017243bb6ac214173622fd105714db0c97969a44c148eb09dc4f'
HELPER = br'''
# CellXplorer: lazy, memory-only timezone resource loader.
proc ::tcl::clock::LoadArchivedTimeZone {fileName} {
    variable DataDir
    variable CellXplorerZoneScripts
    if {![info exists CellXplorerZoneScripts]} {
        source -encoding utf-8 [file join [file dirname $DataDir] tzdata.tcl]
    }
    set bytes [zlib decompress [binary decode base64 [dict get $CellXplorerZoneScripts $fileName]]]
    # Match source's UTF-8 decoding and text-channel newline translation.
    set script [string map [list "\r\n" "\n" "\r" "\n"] [encoding convertfrom utf-8 $bytes]]
    uplevel 1 $script
}
'''


def pack(bundle: Path) -> dict:
    bundle = bundle.resolve(strict=True)
    internal = bundle / '_internal'
    tcl = internal / '_tcl_data'
    zones = tcl / 'tzdata'
    clock = tcl / 'clock.tcl'
    if not (bundle / 'cellxplorer-backend.exe').is_file():
        raise ValueError('Expected an owned CellXplorer backend bundle')
    paths = [internal, tcl, clock, zones, *zones.rglob('*')]
    if any(p.is_symlink() or p.is_junction() or not p.resolve().is_relative_to(bundle) for p in paths):
        raise ValueError('Tcl resources must be contained and free of links/junctions')
    original = clock.read_bytes()
    # Fail closed on upstream changes, including the security-sensitive guard.
    normalised = original.replace(b'\r\n', b'\n')
    loader = re.search(rb'proc ::tcl::clock::LoadTimeZoneFile \{ fileName \} \{.*?\n\}\n', normalised, re.S)
    if loader is None or original.count(ORIGINAL) != 1 or hashlib.sha256(loader[0]).hexdigest() != LOADER_SHA256:
        raise ValueError('Unrecognised Tcl clock loader; preserve original resources')
    members = {p.relative_to(zones).as_posix(): p.read_bytes() for p in sorted(zones.rglob('*')) if p.is_file()}
    if not {'UTC', 'Europe/Paris', 'US/Eastern'}.issubset(members):
        raise ValueError('Incomplete Tcl timezone collection')
    entries = []
    for name, data in members.items():
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+(?:/[A-Za-z0-9_.+-]+)*', name):
            raise ValueError('Unsafe Tcl archive member')
        encoded = base64.b64encode(zlib.compress(data, 9))
        if zlib.decompress(base64.b64decode(encoded)) != data:
            raise ValueError('Tcl resource bytes changed')
        entries.append(b'    ' + name.encode('ascii') + b' ' + encoded + b'\n')
    archive = b'# Unchanged Tcl timezone scripts, independently zlib compressed.\nset ::tcl::clock::CellXplorerZoneScripts {\n' + b''.join(entries) + b'}\n'
    destination = tcl / 'tzdata.tcl'
    if destination.exists():
        raise ValueError('Refusing to replace an existing Tcl archive')
    destination.write_bytes(archive)
    if destination.read_bytes() != archive:
        raise ValueError('Tcl archive write verification failed')
    clock.write_bytes(original.replace(ORIGINAL, REPLACEMENT) + HELPER)
    # Remove only the validated generated subtree, after the container is durable.
    shutil.rmtree(zones)
    return dict(files_replaced=len(members), archive_bytes=len(archive), sha256=hashlib.sha256(archive).hexdigest())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    print(json.dumps(pack(parser.parse_args().bundle), indent=2))
