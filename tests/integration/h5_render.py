"""Deterministic real CSV, JSON, PDF and DST package checks."""
import csv
import hashlib
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from export_package import canonical, package, rows, safe_text, csv_detail, HEADINGS  # noqa: E402
from pypdf import PdfReader


def sample(zone, start, end, code="=SUM(1,1)"):
    org, employee, session, policy = (str(i) * 36 for i in "1234")
    return {"schema_version": 1, "organization_id": org, "employee_id": employee,
            "local_start": "2026-01-01", "local_end": "2026-12-31", "timezone": zone,
            "cutoff_at": "2026-12-31T23:59:59+00:00",
            "employees": [{"id": employee, "code": code, "display_name": '"Alfa,\nBeta',
                "classifications": [], "sessions": [{"id": session, "timezone": zone,
                    "policy": {"id": policy, "version": 1, "break_counts_as_work": False},
                    "originals": [{"id": "event-in"}, {"id": "event-out"}], "adjustments": [],
                    "effective": [
                        {"event_id": "event-in", "adjustment_id": None, "event_type": "CLOCK_IN",
                         "effective_at": start, "ordinal": 1, "source": "WEB", "actor_membership_id": "actor"},
                        {"event_id": "event-out", "adjustment_id": None, "event_type": "CLOCK_OUT",
                         "effective_at": end, "ordinal": 2, "source": "WEB", "actor_membership_id": "actor"}
                    ]}]}]}


class Render(unittest.TestCase):
    def test_csv_json_pdf_digest(self):
        snapshot = sample("Europe/Madrid", "2026-02-01T10:00:00Z", "2026-02-01T11:00:00Z")
        data, digest = package(snapshot)
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())
        self.assertEqual((data, digest), package(snapshot))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            csv_data = archive.read("detail.csv").decode("utf-8")
            record = next(csv.DictReader(io.StringIO(csv_data)))
            self.assertEqual(record["employee_code"], "'=SUM(1,1)")
            self.assertEqual(record["employee_name"], '"Alfa,\nBeta')
            self.assertEqual(record["computable_seconds"], "3600")
            self.assertEqual(archive.read("evidence.json"), canonical(snapshot))
            self.assertEqual(json.loads(archive.read("evidence.json")), snapshot)
            pdf = archive.read("summary.pdf")
            self.assertTrue(pdf.startswith(b"%PDF-"))
            self.assertIn(b"Registro horario", pdf)
            text = '\n'.join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)
            self.assertIn('computable 3600 s', text)
            self.assertIn('No es firma electronica cualificada', text)
            manifest = json.loads(archive.read("manifest.json"))
            for name, expected in manifest["files_sha256"].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected)

    def test_all_formula_prefixes(self):
        for prefix in ("=", "+", "-", "@", "\t", "\r"):
            self.assertEqual(safe_text(prefix + "cmd"), "'" + prefix + "cmd")
            value = prefix+'formula,"quoted"\r\nnext line'
            decoded = next(csv.DictReader(io.StringIO(csv_detail([dict.fromkeys(HEADINGS,value)]).decode())))
            self.assertTrue(all(decoded[key]=="'"+value for key in HEADINGS))
        self.assertEqual(safe_text("ordinary"), "ordinary")

    def test_dst_and_night(self):
        for zone, spring, autumn in (
            ("Europe/Madrid", ("2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z"),
             ("2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")),
            ("Atlantic/Canary", ("2026-03-29T00:00:00Z", "2026-03-29T23:00:00Z"),
             ("2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z")),
        ):
            self.assertEqual(sum(r["gross_seconds"] for r in rows(sample(zone, *spring))), 23 * 3600)
            self.assertEqual(sum(r["gross_seconds"] for r in rows(sample(zone, *autumn))), 25 * 3600)
            self.assertEqual({r['natural_day'] for r in rows(sample(zone,*spring))},{'2026-03-29'})
            self.assertEqual({r['natural_day'] for r in rows(sample(zone,*autumn))},{'2026-10-25'})
        night = rows(sample("Europe/Madrid", "2026-04-01T20:00:00Z", "2026-04-02T05:00:00Z"))
        self.assertEqual([r["natural_day"] for r in night], ["2026-04-01", "2026-04-02"])
        self.assertEqual({r["local_entry_day"] for r in night}, {"2026-04-01"})

    def test_open_not_zero(self):
        snapshot = sample("Europe/Madrid", "2026-02-01T10:00:00Z", "2026-02-01T11:00:00Z")
        snapshot["employees"][0]["sessions"][0]["effective"].pop()
        record = rows(snapshot)[0]
        self.assertEqual(record["status"], "OPEN_SESSION")
        for key in ("gross_seconds", "break_seconds", "net_seconds", "computable_seconds"):
            self.assertIsNone(record[key])


if __name__ == "__main__":
    unittest.main()
