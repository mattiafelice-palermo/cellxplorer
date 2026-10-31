"""Read buffered native worker timing markers without using replay timestamps."""
import argparse
import json
from pathlib import Path


def parse_markers(text):
    events = []
    for line in text.splitlines():
        if 'CXCI_TIMING ' not in line:
            continue
        row = json.loads(line.split('CXCI_TIMING ', 1)[1])
        if row['event'] not in ('begin', 'end') or not row['name'] or not row['utc']:
            raise ValueError('Invalid native timing marker')
        if row['event'] == 'end' and (row['elapsed_ms'] < 0 or row['status'] not in ('passed', 'failed')):
            raise ValueError('Invalid native completion marker')
        events.append(row)
    return events


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    args = parser.parse_args()
    events = parse_markers(args.log.read_text(encoding='utf-8-sig'))
    print(json.dumps({'events': events, 'completion_durations_are_worker_measured': True,
                      'warning': 'Overlapping phases/workers must not be summed as job wall time.'}, indent=2))
