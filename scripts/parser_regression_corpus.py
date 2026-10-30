"""Private, checksum-verified parser regression archive (never needed by CI).

Registration copies original bytes. Snapshot is an explicit baseline operation;
verify only reads expectations and always computes in disposable application data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = ROOT / '.local-regression' / 'parser-corpus'


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_manifest(root: Path) -> dict:
    path = root / 'manifest.json'
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('version') != 1 or not isinstance(value.get('cases'), list) or not value['cases']:
        raise ValueError('Missing or invalid corpus cases')
    ids = [case['id'] for case in value['cases']]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', x) for x in ids):
        raise ValueError('Invalid or duplicate case IDs')
    return value


def checked_sources(root: Path, manifest: dict) -> dict[str, Path]:
    paths = {}
    for case in manifest['cases']:
        path = (root / case['file']).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError(f"Missing source for {case['id']}")
        if digest(path) != case['sha256']:
            raise ValueError(f"Checksum mismatch for {case['id']}")
        paths[case['id']] = path
    return paths


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n', encoding='utf-8')
    temp.replace(path)


def register(root: Path, case_id: str, source: Path, chain: str) -> None:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', case_id):
        raise ValueError('Case ID must contain lowercase letters, digits and hyphens')
    if not source.is_file() or source.suffix.lower() != '.mpr':
        raise ValueError('Registration requires an existing original MPR source')
    manifest = read_manifest(root) if (root/'manifest.json').exists() else {'version':1,'cases':[]}
    if any(case['id'] == case_id for case in manifest['cases']):
        raise ValueError('Case ID already registered; existing originals are immutable')
    checksum = digest(source)
    destination = root / 'sources' / f'{case_id}.mpr'
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents accidental replacement of an archived original.
    with source.open('rb') as original, destination.open('xb') as copy:
        shutil.copyfileobj(original,copy)
    if digest(destination) != checksum or digest(source) != checksum:
        raise ValueError('Source changed during registration')
    destination.chmod(stat.S_IREAD)
    manifest['cases'].append({'id':case_id,'file':destination.relative_to(root).as_posix(),
                              'sha256':checksum,'original_name':source.name,'chain':chain})
    write_json(root/'manifest.json',manifest)


def scientific_snapshot(manifest: dict, paths: dict[str, Path], work: Path) -> dict:
    # Set this before importing any application code. Never open a real profile.
    os.environ['CELLXPLORER_DATA'] = str(work)
    sys.path.insert(0,str(ROOT/'backend'))
    import numpy as np
    import pandas as pd
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.db import Base
    from app.models import Cell, Test, TestFile
    from app.services import cache, parsing, scanner, stitch, calc, analysis_engine
    from app.routers.files import _build_continuation_preview

    cache.CACHE_DIR = work/'cache'
    def frame_hash(frame):
        digestor = hashlib.sha256()
        digestor.update(json.dumps([(col,str(dtype)) for col,dtype in frame.dtypes.items()]).encode())
        digestor.update(pd.util.hash_pandas_object(frame,index=False).to_numpy().tobytes())
        return digestor.hexdigest()
    def table(frame):
        # Exact Python floats survive JSON round trips; no tolerance is applied.
        return {'columns':list(frame.columns),'rows':frame.astype(object).where(pd.notnull(frame),None).values.tolist()}
    engine=create_engine('sqlite://')
    Base.metadata.create_all(engine)
    output={'cases':{},'chains':{}}
    with sessionmaker(bind=engine,expire_on_commit=False)() as db:
        sources={}
        for case in manifest['cases']:
            case_id=case['id'];path=paths[case_id]
            source=scanner.ingest_path(db,path,parse_now=True)
            if source.parse_status != 'parsed':
                raise ValueError(f"Parse failed for {case_id}: {source.parse_error}")
            sources[case_id]=source
            fresh=parsing.parse_timeseries(path)
            raw=cache.load_raw(source.hash,source.parser_version)
            pd.testing.assert_frame_equal(fresh,raw,check_exact=True)
            cycles=cache.load_cycles(source.hash,source.parser_version,cache.CALC_VERSION)
            pd.testing.assert_frame_equal(calc.per_cycle(raw),cycles,check_exact=True)
            warnings=cache.load_parser_warnings(source.hash,source.parser_version)
            selective=cache.load_raw_cycles(source.hash,source.parser_version,
                raw.cycle.unique().tolist()[-2:],list(raw.columns))
            expected_select=raw[raw.cycle.isin(raw.cycle.unique().tolist()[-2:])].reset_index(drop=True)
            pd.testing.assert_frame_equal(selective.reset_index(drop=True),expected_select,check_exact=True)
            output['cases'][case_id]={'rows':len(raw),'raw_sha256':frame_hash(raw),
                'cycles':table(cycles),'warnings':warnings,
                'replay_provenance':raw.attrs.get('biologic_gcpl',{}).get('skipped_replayed_blocks',[])}
        chains={}
        for case in manifest['cases']:
            chains.setdefault(case['chain'],[]).append(case['id'])
        for chain,ids in chains.items():
            # Both input orders must resolve to the same scientific acquisition.
            results=[]
            for order in (ids,list(reversed(ids))):
                ordered=[sources[x] for x in order]
                cell=Cell(name=f'{chain}-{len(results)}');db.add(cell);db.flush()
                internal=Test(cell_id=cell.id,name='internal');db.add(internal);db.flush()
                db.add_all([TestFile(test_id=internal.id,file_id=s.id,position=i) for i,s in enumerate(ordered)])
                db.commit()
                refs=[stitch.CachedSourceRef(s.hash,s.parser_version) for s in ordered]
                raw,_,missing=stitch.stitch_raw(refs)
                cycles,_,missing_cycles=stitch.stitch_cycles(refs,cache.CALC_VERSION)
                if missing or missing_cycles:raise ValueError('Missing stitched source cache')
                # Concatenating an empty source summary may coerce the stitched
                # cycle identifier to object; compare every value exactly.
                recomputed=calc.per_cycle(raw)
                cycles=cycles[calc.CYCLE_COLUMNS].astype(recomputed.dtypes.to_dict())
                pd.testing.assert_frame_equal(recomputed,cycles,check_exact=True)
                spec=analysis_engine.default_spec('Private parser regression')
                spec['selection']['entries']=[{'kind':'cell','ref_id':cell.id}]
                analyzed={}
                for quantity,column in [('charge_capacity','charge_capacity_mah'),
                                        ('discharge_capacity','discharge_capacity_mah'),
                                        ('coulombic_efficiency','coulombic_efficiency_pct')]:
                    spec['computation']['quantity']=quantity
                    series=analysis_engine.compute(db,spec,None,use_current_versions=True)['cell_series'][0]
                    values=series['quantities'][column]
                    np.testing.assert_allclose(values,cycles[column],rtol=0,atol=1e-10,equal_nan=True)
                    analyzed[quantity]={'x':series['x'],'y':values}
                staged=[{'hash':s.hash,'parser_version':s.parser_version,'source_key':str(i),
                         'filename':s.filename} for i,s in enumerate(ordered)]
                preview=_build_continuation_preview(staged,quantity='capacity_bundle')
                preview_values={name:[v for seg in preview['segments'] for v in seg[name]]
                    for name in ('charge_capacity_x','charge_capacity_y','discharge_capacity_x',
                                 'discharge_capacity_y','coulombic_efficiency_x','coulombic_efficiency_pct')}
                for key,col in [('charge_capacity_y','charge_capacity_mah'),('discharge_capacity_y','discharge_capacity_mah'),
                                ('coulombic_efficiency_pct','coulombic_efficiency_pct')]:
                    xkey={'charge_capacity_y':'charge_capacity_x','discharge_capacity_y':'discharge_capacity_x',
                          'coulombic_efficiency_pct':'coulombic_efficiency_x'}[key]
                    selected=cycles.set_index('cycle').loc[preview_values[xkey],col]
                    np.testing.assert_allclose(np.asarray(preview_values[key],dtype=float),
                                               np.asarray(selected,dtype=float),rtol=0,atol=1e-10,equal_nan=True)
                tc=analysis_engine.compute_time_capacity(db,spec,None,use_current_versions=True)
                if not tc['cell_traces']:raise ValueError('Missing Time/Capacity traces')
                trace_keys=('cycle','display_x','time_s','capacity_mah','capacity_mah_g',
                            'capacity_mah_cm2','voltage_v','voltage_v_by_channel','current_ma',
                            'phase','status','derivative_x','derivative_y','source_boundary_indices')
                trace_science=[{key:trace[key] for key in trace_keys if key in trace}
                               for trace in tc['cell_traces']]
                trace_hash=hashlib.sha256(json.dumps(trace_science,sort_keys=True,
                    separators=(',',':'),allow_nan=False).encode()).hexdigest()
                results.append({'rows':len(raw),'cycles':table(cycles[calc.CYCLE_COLUMNS]),
                                'analysis':analyzed,'preview':preview_values,'time_capacity_sha256':trace_hash})
                db.query(TestFile).filter(TestFile.test_id==internal.id).delete()
                db.commit()
            # Scalar outputs must be independent of the user supplied order.
            trace_hashes=[result.pop('time_capacity_sha256') for result in results]
            if results[0] != results[1]:raise ValueError(f'Input-order scalar scientific difference in {chain}')
            # Time/Capacity selects windows along the explicit source chain,
            # so retain a separate exact trace baseline for each input order.
            output['chains'][chain]={**results[0],'time_capacity_sha256_by_order':trace_hashes}
    engine.dispose()
    # Normalize numpy scalar types and nonfinite scientific gaps to JSON null.
    def clean(value):
        if isinstance(value,dict):return {str(k):clean(v) for k,v in value.items()}
        if isinstance(value,(tuple,list)):return [clean(v) for v in value]
        if isinstance(value,np.generic):return clean(value.item())
        if isinstance(value,pd.Timestamp):return value.isoformat()
        if isinstance(value,float) and not np.isfinite(value):return None
        return value
    return clean(output)


def run(root: Path, command: str, *, replace: bool=False) -> dict:
    manifest=read_manifest(root)
    paths=checked_sources(root,manifest)
    expected=root/'expected.json'
    if command=='verify':
        if not expected.is_file():raise ValueError('Missing expectations; capture an explicitly reviewed snapshot first')
        baseline=json.loads(expected.read_text(encoding='utf-8'))
        checksums={case['id']:case['sha256'] for case in manifest['cases']}
        if baseline.get('version')!=1 or baseline.get('sources')!=checksums:
            raise ValueError('Expectations do not match registered source membership/checksums')
    elif expected.exists() and not replace:
        raise ValueError('Expectations already exist; replacement requires --replace-expectations')
    # Windows AppContainer temp roots can exceed MAX_PATH when Parquet adds its
    # hash and atomic-candidate suffix. Use a short disposable workspace path.
    scratch=ROOT/'tmp'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pc-',dir=scratch) as temp:
        actual=scientific_snapshot(manifest,paths,Path(temp))
    # Detect any concurrent source edit as well as an initial integrity failure.
    checked_sources(root,manifest)
    if command=='verify':
        if actual != baseline['science']:
            raise ValueError('Scientific regression: current output differs from frozen expectations')
    else:
        write_json(expected,{'version':1,'sources':{c['id']:c['sha256'] for c in manifest['cases']},'science':actual})
    return {'verified':command=='verify','cases':len(paths),'chains':len(actual['chains']),
            'chain_cycles':{name:len(value['cycles']['rows']) for name,value in actual['chains'].items()}}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=DEFAULT_ROOT)
    sub=parser.add_subparsers(dest='command',required=True)
    registration=sub.add_parser('register')
    registration.add_argument('--case-id',required=True)
    registration.add_argument('--source',required=True,type=Path)
    registration.add_argument('--chain',required=True)
    snapshot=sub.add_parser('snapshot')
    snapshot.add_argument('--replace-expectations',action='store_true')
    sub.add_parser('verify')
    args=parser.parse_args(argv)
    try:
        if args.command=='register':
            register(args.root.resolve(),args.case_id,args.source,args.chain)
            print(json.dumps({'registered':args.case_id}))
        else:print(json.dumps(run(args.root.resolve(),args.command,replace=getattr(args,'replace_expectations',False))))
    except (ValueError,KeyError,OSError,AssertionError) as error:
        print(f'Corpus check failed: {error}',file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
