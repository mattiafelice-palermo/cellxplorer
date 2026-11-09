"""Interleaved extraction-only A/B; no install registration or application launch."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PureWindowsPath
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.services.filesystem_cleanup import remove_tree


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def group(name):
    if '/pyarrow/' in name:
        return 'pyarrow'
    if '/_tcl_data/tzdata/' in name or name.endswith('/_tcl_data/tzdata.tcl'):
        return 'Tcl_timezones'
    return 'other'


def validate_rows(rows):
    names = set()
    for row in rows:
        name = row['path']
        relative = PureWindowsPath(name)
        if relative.is_absolute() or relative.drive or '..' in relative.parts or any(c in name for c in '$"\n\r'):
            raise ValueError('Unsafe payload destination')
        if name.lower() in names:
            raise ValueError('Duplicate payload destination')
        names.add(name.lower())
        source = Path(row['source']).resolve(strict=True)
        if not source.is_relative_to(ROOT) or any(c in str(source) for c in '$"\n\r') or source.is_symlink() or source.is_junction():
            raise ValueError('Expected an owned repository payload')
        if digest(source) != row['sha256'] or source.stat().st_size != row['bytes']:
            raise ValueError('Payload changed since manifest creation')


def compile_fixture(rows, name, out, compiler, profiled):
    exe = out / (name + '.exe')
    lines = ['Unicode true', f'Name "Extraction-only {name}"', f'OutFile "{exe}"',
             'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true',
             'SetCompressor /SOLID zlib', 'Section', 'SetOutPath $INSTDIR']
    if profiled:
        lines += ["System::Call 'kernel32::QueryPerformanceFrequency(*l .r8) i .r2'", 'FileOpen $9 "$INSTDIR\\profile.tsv" w', 'FileWrite $9 "$8$\\r$\\n"']
    directories = set()
    for row in rows:
        parent = PureWindowsPath(row['path']).parent
        directories.update(p.as_posix() for p in [parent, *parent.parents] if str(p) != '.')
    if profiled:
        lines.append("System::Call 'kernel32::QueryPerformanceCounter(*l .r0) i .r2'")
    for path in sorted(directories):
        lines.append(f'CreateDirectory "$INSTDIR\\{path.replace(chr(47), chr(92))}"')
    if profiled:
        lines += ["System::Call 'kernel32::QueryPerformanceCounter(*l .r1) i .r2'", 'FileWrite $9 "directories$\\t$0$\\t$1$\\r$\\n"']
    previous = None
    for row in rows:
        current = group(row['path'])
        if profiled and current != previous:
            if previous is not None:
                lines += ["System::Call 'kernel32::QueryPerformanceCounter(*l .r1) i .r2'", f'FileWrite $9 "{previous}$\\t$0$\\t$1$\\r$\\n"']
            lines.append("System::Call 'kernel32::QueryPerformanceCounter(*l .r0) i .r2'")
        lines.append(f'File /a "/oname={row["path"].replace(chr(47), chr(92))}" "{row["source"]}"')
        previous = current
    if profiled:
        lines += ["System::Call 'kernel32::QueryPerformanceCounter(*l .r1) i .r2'", f'FileWrite $9 "{previous}$\\t$0$\\t$1$\\r$\\n"', 'FileClose $9']
    lines.append('SectionEnd')
    script = out / (name + '.nsi')
    script.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    subprocess.run([str(compiler), '/V2', '/INPUTCHARSET', 'UTF8', str(script)], check=True, timeout=180)
    return exe


def trial(exe, rows, target, profiled):
    if target.exists() or target.is_symlink() or target.resolve().parent != exe.parent.resolve():
        raise ValueError('Expected fresh owned destination')
    begin = time.perf_counter()
    subprocess.run([str(exe), '/S', '/D=' + str(target)], check=True, timeout=120)
    result = dict(wall_seconds=time.perf_counter() - begin)
    if profiled:
        trace = (target / 'profile.tsv').read_text(encoding='utf-8-sig').splitlines()
        frequency = int(trace[0])
        phases = {}
        for row in trace[1:]:
            key, start, end = row.split('\t')
            phases[key] = phases.get(key, 0.0) + (int(end) - int(start)) / frequency
        result['phases_seconds'] = phases
    for row in rows:
        if digest(target / row['path']) != row['sha256']:
            raise ValueError('Extracted payload differs')
    if len([p for p in target.rglob('*') if p.is_file()]) != len(rows) + int(profiled):
        raise ValueError('Unexpected extracted file count')
    # Full hash verification/cleanup is outside the timed extraction process.
    if target.resolve().parent != exe.parent.resolve() or target.is_symlink() or target.is_junction():
        raise ValueError('Refusing out-of-scope cleanup')
    remove_tree(target)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-manifest', type=Path, required=True)
    parser.add_argument('--candidate-backend', type=Path, default=ROOT / 'src-tauri/binaries/backend')
    parser.add_argument('--makensis', type=Path, default=Path('C:/Users/matti/AppData/Local/tauri/NSIS/makensis.exe'))
    parser.add_argument('--trials', type=int, default=5)
    args = parser.parse_args()
    if args.trials < 3:
        parser.error('At least three interleaved trials are required')
    baseline = json.loads(args.baseline_manifest.read_text())
    validate_rows(baseline)
    candidate = [r for r in baseline if not r['path'].startswith('binaries/backend/')]
    for path in sorted(args.candidate_backend.rglob('*')):
        if path.is_file():
            candidate.append(dict(path='binaries/backend/' + path.relative_to(args.candidate_backend).as_posix(), source=str(path.resolve()), bytes=path.stat().st_size, sha256=digest(path)))
    validate_rows(candidate)
    # Identical desktop/helper bytes isolate the changed backend packaging.
    payloads = dict(baseline=baseline, candidate=candidate)
    out = Path(tempfile.mkdtemp(prefix='102-comparison-', dir=ROOT / 'tmp')).resolve()
    print(json.dumps(dict(output=str(out))), flush=True)
    executables = {(name, mode): compile_fixture(rows, name + '-' + mode, out, args.makensis, mode == 'profiled') for name, rows in payloads.items() for mode in ('control', 'profiled')}
    trials = []
    order = list(executables)
    for index in range(args.trials):
        for name, mode in order if index % 2 == 0 else reversed(order):
            result = dict(payload=name, mode=mode, trial=index, **trial(executables[name, mode], payloads[name], out / f'trial-{name}-{mode}-{index}', mode == 'profiled'))
            trials.append(result)
            print(json.dumps(result), flush=True)
    summary = {}
    for name, rows in payloads.items():
        summary[name] = dict(files=len(rows), bytes=sum(r['bytes'] for r in rows), payload=rows)
        for mode in ('control', 'profiled'):
            times = [r['wall_seconds'] for r in trials if r['payload'] == name and r['mode'] == mode]
            summary[name][mode] = dict(median=statistics.median(times), minimum=min(times), maximum=max(times))
        phases = [r['phases_seconds'] for r in trials if r['payload'] == name and r['mode'] == 'profiled']
        summary[name]['phase_medians'] = {key: statistics.median(p[key] for p in phases) for key in phases[0]}
    report = dict(boundary='Extraction-only NSIS /SOLID zlib; identical desktop/helper; disposable fresh paths; no installed apps, registration, UAC, WebView installation, shutdown or update handoff. Cache and antivirus unchanged. Hash verification and cleanup excluded from timing.', trials=trials, summary=summary)
    (out / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(dict(results=str(out / 'results.json'), summary={k: {key: value for key, value in v.items() if key != 'payload'} for k, v in summary.items()})), flush=True)


if __name__ == '__main__':
    main()
