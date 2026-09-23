"""Render a materialized H5 evidence snapshot. No database access in this module.

The caller stores the returned ZIP in private storage. The digest is an ordinary
SHA-256 integrity check, never an electronic signature.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit


HEADINGS = (
    "organization_id", "employee_id", "employee_code", "employee_name",
    "session_id", "local_entry_day", "natural_day", "timezone", "status",
    "original_event_ids", "adjustment_ids", "effective_event_ids", "sources",
    "actors", "policy_id", "policy_version", "gross_seconds", "break_seconds",
    "net_seconds", "computable_seconds", "classification_ids",
)


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def safe_text(value: Any) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def seconds(start: datetime, end: datetime) -> int:
    return round((end - start).total_seconds())


def natural_segments(start: datetime, end: datetime, zone: ZoneInfo):
    """Split in UTC at successive local midnights, including 23/25 h days."""
    cursor = start
    while cursor < end:
        day = cursor.astimezone(zone).date()
        boundary = datetime.combine(day + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
        stop = min(boundary, end)
        if stop <= cursor:
            raise ValueError("Invalid local midnight boundary")
        yield day.isoformat(), cursor, stop
        cursor = stop


def rows(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    output = []
    for employee in snapshot["employees"]:
        for session in employee["sessions"]:
            zone = ZoneInfo(session["timezone"])
            events = sorted(session["effective"],
                            key=lambda e: (instant(e["effective_at"]), e["ordinal"]))
            if not events:
                continue
            entry = instant(events[0]["effective_at"]).astimezone(zone).date().isoformat()
            if events[0]["event_type"] != "CLOCK_IN":
                raise ValueError("Invalid effective session entry")
            closed = events[-1]["event_type"] == "CLOCK_OUT"
            grouped: dict[str, dict[str, int]] = {}
            for current, next_event in zip(events, events[1:]):
                start, end = instant(current["effective_at"]), instant(next_event["effective_at"])
                if end < start:
                    raise ValueError("Negative effective interval")
                for day, part_start, part_end in natural_segments(start, end, zone):
                    values = grouped.setdefault(day, {"gross": 0, "break": 0, "computable": 0})
                    length = seconds(part_start, part_end)
                    values["gross"] += length
                    if current["event_type"] == "BREAK_START":
                        values["break"] += length
                        if session["policy"]["break_counts_as_work"]:
                            values["computable"] += length
                    elif current["event_type"] in ("CLOCK_IN", "BREAK_END"):
                        values["computable"] += length
            if not grouped:
                grouped[entry] = {"gross": 0, "break": 0, "computable": 0}
            for day, values in sorted(grouped.items()):
                # An incomplete session has unknown totals, even for a completed
                # interval within it: never present zero as its monthly total.
                output.append({
                    "organization_id": snapshot["organization_id"], "employee_id": employee["id"],
                    "employee_code": employee["code"], "employee_name": employee["display_name"],
                    "session_id": session["id"], "local_entry_day": entry, "natural_day": day,
                    "timezone": session["timezone"], "status": "CLOSED" if closed else "OPEN_SESSION",
                    "original_event_ids": ";".join(e["id"] for e in session["originals"]),
                    "adjustment_ids": ";".join(a["adjustment"]["id"] for a in session["adjustments"]),
                    "effective_event_ids": ";".join(str(e.get("event_id") or e.get("adjustment_id")) for e in events),
                    "sources": ";".join(str(e["source"]) for e in events),
                    "actors": ";".join(str(e.get("actor_membership_id") or "") for e in events),
                    "policy_id": session["policy"]["id"], "policy_version": session["policy"]["version"],
                    "gross_seconds": values["gross"] if closed else None,
                    "break_seconds": values["break"] if closed else None,
                    "net_seconds": values["gross"] - values["break"] if closed else None,
                    "computable_seconds": values["computable"] if closed else None,
                    "classification_ids": ";".join(c["id"] for c in employee["classifications"]
                                                     if c["local_month"][:7] == entry[:7]),
                })
    return output


def csv_detail(entries: list[dict[str, Any]]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, dialect="excel", lineterminator="\r\n")
    writer.writerow(HEADINGS)
    for entry in entries:
        writer.writerow([entry[key] if isinstance(entry[key], int) else safe_text(entry[key])
                         for key in HEADINGS])
    return stream.getvalue().encode("utf-8")


def pdf_summary(snapshot: dict[str, Any], entries: list[dict[str, Any]]) -> bytes:
    stream = io.BytesIO()
    page = canvas.Canvas(stream, pagesize=A4, invariant=1, pageCompression=0)
    page.setTitle("Resumen mensual de registro horario")
    y = 790
    lines = ["Registro horario - resumen mensual", "Organizacion: " + snapshot["organization_id"],
             "Periodo local: " + snapshot["local_start"] + " a " + snapshot["local_end"],
             "Zona de filtro: " + snapshot["timezone"], "Corte UTC: " + snapshot["cutoff_at"]]
    for entry in entries:
        duration = "INCIDENCIA: SESION ABIERTA" if entry["status"] != "CLOSED" else (
            f"bruto {entry['gross_seconds']} s; pausa {entry['break_seconds']} s; "
            f"neto {entry['net_seconds']} s; computable {entry['computable_seconds']} s")
        lines.append(f"{entry['employee_code']} {entry['natural_day']} {entry['session_id']}: {duration}")
    if not entries:
        lines.append("Sin jornadas en el periodo.")
    lines.append("SHA-256 del paquete: ver manifest.json. No es firma electronica cualificada.")
    for line in lines:
        for paragraph in line.splitlines():
            for fragment in simpleSplit(paragraph, 'Helvetica', 9, 525):
                if y < 45:
                    page.showPage()
                    y = 790
                page.setFont('Helvetica', 9)
                page.drawString(35, y, fragment)
                y -= 13
    page.save()
    return stream.getvalue()


def package(snapshot: dict[str, Any]) -> tuple[bytes, str]:
    entries = rows(snapshot)
    files = {"detail.csv": csv_detail(entries), "evidence.json": canonical(snapshot),
             "summary.pdf": pdf_summary(snapshot, entries)}
    files["manifest.json"] = canonical({"schema_version": snapshot["schema_version"],
        "cutoff_at": snapshot["cutoff_at"],
        "files_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())}})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, content)
    data = stream.getvalue()
    return data, hashlib.sha256(data).hexdigest()
