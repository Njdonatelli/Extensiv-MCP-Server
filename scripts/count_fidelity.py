#!/usr/bin/env python3
"""Tally MOCK_FIDELITY.md's Status column so the numbers quoted in README.md and
docs/verification_status.md can be reproduced instead of trusted.

A Status cell is "clean" when it is exactly Documented, Inferred or Guess.
Many rows are deliberately compound ("Documented (shape) / Guess (values)"),
because part of the behaviour is in the docs and part is our reconstruction.
Those are counted separately rather than being forced into one bucket: a single
"N guesses" figure would misstate both groups.
"""
import re
import sys
from pathlib import Path

DOC = Path(__file__).resolve().parent.parent / 'packages' / 'mock-extensiv' / 'MOCK_FIDELITY.md'
CLEAN = ('Documented', 'Inferred', 'Guess')


def tables(lines):
    cur = []
    for ln in lines:
        if ln.startswith('|'):
            cur.append(ln)
        elif cur:
            yield cur
            cur = []
    if cur:
        yield cur


def main() -> int:
    counts = {k: 0 for k in CLEAN}
    compound = 0
    status_rows = 0
    status_tables = 0
    for t in tables(DOC.read_text().splitlines()):
        rows = [[c.strip() for c in r.strip('|').split('|')] for r in t]
        if len(rows) < 3 or 'Status' not in rows[0]:
            continue
        status_tables += 1
        ci = rows[0].index('Status')
        for r in rows[2:]:
            if ci >= len(r):
                continue
            status_rows += 1
            v = re.sub(r'\*', '', r[ci]).strip()
            if v in CLEAN:
                counts[v] += 1
            else:
                compound += 1
    clean = sum(counts.values())
    print(f'MOCK_FIDELITY.md: {status_rows} status-bearing rows across {status_tables} tables')
    print(f'  single-label : {clean}  ({counts["Documented"]} Documented, {counts["Inferred"]} Inferred, {counts["Guess"]} Guess)')
    print(f'  compound     : {compound}  (part documented, part inferred or guessed)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
