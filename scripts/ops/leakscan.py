"""OPS-02 leak scanner for telemetry, alerts, reports and logs (OBS-01/07).

Reports only (source, rule): a matched value is never printed. Generic rules
catch secret-shaped material, personal data shapes, SQL text and stack traces;
`known` adds exact synthetic values the harness created (PINs, passwords,
challenges, JWTs, emails, names, employee codes, record identifiers, reasons).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

GENERIC = [
    ('jwt', re.compile(rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ('supabase-secret-key', re.compile(rb'sb_secret_[A-Za-z0-9_-]{10,}')),
    ('service-role', re.compile(rb'service_role', re.I)),
    ('bearer', re.compile(rb'Bearer\s+[A-Za-z0-9._-]{16,}')),
    ('postgres-credential', re.compile(rb'postgres(?:ql)?://[^\s:@/\'"`]+:[^\s@/\'"`]+@')),
    ('private-key', re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('age-secret-key', re.compile(rb'AGE-SECRET-KEY-1[0-9A-Z]{20,}')),
    ('github-token', re.compile(rb'\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')),
    ('signed-url', re.compile(rb'/object/sign/[^\s"\']+token=')),
    ('email', re.compile(rb'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(invalid|com|es|org|net|io|dev|test)\b')),
    ('sql-text', re.compile(rb'\b(select\s[^"\n]{0,200}\sfrom\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s)', re.I)),
    ('traceback', re.compile(rb'Traceback \(most recent call last\)|\n\s+at [^\n]+:\d+:\d+')),
    ('pepper-env', re.compile(rb'KIOSK_PEPPER|KIOSK_NETWORK_SECRET|SUPABASE_SERVICE_ROLE_KEY|KIOSK_AUTH_PROVISION_KEY')),
    # H7: edge ingress secret, alert route credentials and platform tokens.
    ('h7-secret-env', re.compile(rb'FICHAJE_INGRESS_SECRET|OPS_PAGERDUTY_ROUTING_KEY|OPS_GITHUB_TOKEN|CLOUDFLARE_API_TOKEN|SUPABASE_ACCESS_TOKEN')),
    ('platform-token', re.compile(rb'\bsbp_[A-Za-z0-9]{30,}')),
]


def scan(blobs: dict[str, bytes], known: list[str] | None = None, rules: list[str] | None = None) -> list[tuple[str, str]]:
    """Return [(source, rule)] for every finding."""
    findings = []
    selected = [r for r in GENERIC if rules is None or r[0] in rules]
    values = [v.encode() for v in (known or []) if isinstance(v, str) and len(v) >= 6]
    for source, blob in blobs.items():
        for name, pattern in selected:
            if pattern.search(blob):
                findings.append((source, name))
        if any(value in blob for value in values):
            findings.append((source, 'known-sensitive-value'))
    return findings


def files(paths) -> dict[str, bytes]:
    out = {}
    for base in paths:
        base = Path(base)
        items = [base] if base.is_file() else [p for p in base.rglob('*') if p.is_file()] if base.exists() else []
        for item in items:
            out[str(item)] = item.read_bytes()
    return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Scan OPS-02 outputs for secrets and personal data (prints paths and rules only)')
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args()
    found = scan(files(args.paths))
    for source, rule in found:
        print(f'LEAK_PATTERN {rule} in {source}', file=sys.stderr)
    print(f'scanned {len(files(args.paths))} files, {len(found)} findings')
    sys.exit(1 if found else 0)
