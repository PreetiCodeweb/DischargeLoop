#!/usr/bin/env python3
"""End-to-end MVP smoke test against a running stack, through the web app's same-origin /api proxy.

Walks one realistic ward day: EHR admit (HL7 A01) -> pending discharge (A16) -> role-gated clearance ->
task fan-out to functional roles -> external blocker -> READY gate -> pharmacy auto-completion (RDE) ->
"2 PM fever" reversal -> restart with regenerated checklist -> EHR departure (A03) -> two-person cleaning ->
bed available; plus ward scoping, lockout, HL7 auth/idempotency and every UI route.

Secrets are read from the repo's .env and never printed. Staff accounts it creates are deleted at the end.
Usage: python3 scripts/e2e_smoke.py [--base http://127.0.0.1:3001]
"""
from __future__ import annotations

import argparse
import json
import secrets
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS: list[tuple[bool, str]] = []


def env() -> dict[str, str]:
    values = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def call(self, method: str, path: str, token: str | None = None, body=None, form=None, raw: str | None = None,
             headers: dict | None = None) -> tuple[int, object]:
        hdrs = {"X-Correlation-Id": f"e2e-{uuid.uuid4()}", **(headers or {})}
        data = None
        if token:
            hdrs["Authorization"] = f"Bearer {token}"
        if body is not None:
            data, hdrs["Content-Type"] = json.dumps(body).encode(), "application/json"
        elif form is not None:
            data, hdrs["Content-Type"] = urllib.parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
        elif raw is not None:
            data, hdrs["Content-Type"] = raw.encode(), "application/hl7-v2"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                text = resp.read().decode()
                status = resp.status
        except urllib.error.HTTPError as err:
            text, status = err.read().decode(), err.code
        try:
            return status, json.loads(text) if text else None
        except json.JSONDecodeError:
            return status, text


def check(ok: bool, label: str, detail: object = "") -> bool:
    RESULTS.append((ok, label))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + ("" if ok or detail == "" else f"  -> {str(detail)[:300]}"), flush=True)
    return ok


def hl7(trigger: str, visit: str, location: str, mrn: str, extra: str = "", control: str | None = None) -> str:
    msg_type = trigger if trigger in ("RDE^O11", "ORU^R01") else f"ADT^{trigger}"
    return (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||{msg_type}|{control or uuid.uuid4().hex[:18]}|P|2.5.1\r"
            f"PID|1||{mrn}^^^NSGH^MR||E2E^Patient||19480214|F\r"
            f"PV1|1|I|{location}" + "|" * 16 + f"{visit}\r{extra}")


def mllp_send(port: int, message: str) -> str:
    """Send one HL7 message over MLLP (VT ... FS CR) like Epic Bridges does and return the ACK text."""
    with socket.create_connection(("127.0.0.1", port), timeout=20) as sock:
        sock.sendall(b"\x0b" + message.encode() + b"\x1c\x0d")
        data = b""
        while not data.endswith(b"\x1c\x0d"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    return data.strip(b"\x0b\x1c\x0d").decode(errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:3001")
    api = Api(parser.parse_args().base)
    cfg = env()
    hl7_auth = {"Authorization": f"Bearer {cfg['DL_HL7_INGEST_TOKEN']}"}

    # ---------------------------------------------------------------- security baseline
    check(api.call("GET", "/api/v1/dl/worklist")[0] == 401, "Worklist requires a session (401 without token)")
    check(api.call("GET", "/api/v1/dl/meta")[0] == 401, "Metadata requires a session")
    check(api.call("POST", "/api/v1/integrations/hl7", raw="MSH|^~\\&|X", headers={"Authorization": "Bearer wrong"})[0] == 401,
          "HL7 endpoint rejects a wrong integration token")

    status, tok = api.call("POST", "/api/v1/auth/login", form={"username": cfg["DL_ADMIN_EMAIL"], "password": cfg["DL_ADMIN_PASSWORD"]})
    if not check(status == 200 and isinstance(tok, dict), "Admin signs in", tok):
        return 1
    admin = tok["access_token"]
    status, wards = api.call("GET", "/api/v1/dl/wards", admin)
    ward = next((w for w in wards if w["code"] == "4A"), None) if status == 200 else None
    if not check(ward is not None, "Admin sees hospital-wide ward capacity incl. 4A", wards):
        return 1

    # ---------------------------------------------------------------- staff + ward scope (feature 2 ownership)
    run = uuid.uuid4().hex[:6]
    staff_pw = secrets.token_urlsafe(18)  # in-memory only; accounts are deleted at the end
    roles = {"doctor": "doctor", "nurse": "nurse", "cm": "case_manager", "pharm": "pharmacist",
             "evs1": "housekeeping", "evs2": "housekeeping", "outsider": "nurse"}
    users: dict[str, dict] = {}
    for key, role in roles.items():
        s, u = api.call("POST", "/api/v1/auth/users", admin, {"email": f"e2e-{key}-{run}@northstar.example",
                                                             "full_name": f"E2E {key} {run}", "password": staff_pw, "role": role})
        check(s == 201, f"Admin provisions {role} ({key})", u)
        users[key] = u
        if key != "outsider":
            s, scope = api.call("PUT", f"/api/v1/dl/users/{u['id']}/wards", admin, {"ward_ids": [ward["ward_id"]]})
            check(s == 200 and [w["code"] for w in scope] == ["4A"], f"{key} scoped to ward 4A", scope)
    tokens = {}
    for key in roles:
        s, t = api.call("POST", "/api/v1/auth/login", form={"username": users[key]["email"], "password": staff_pw})
        tokens[key] = t["access_token"] if s == 200 else None
    check(all(tokens.values()), "All staff sign in")
    T = tokens

    try:
        # ---------------------------------------------------------------- minimum necessary
        s, wl = api.call("GET", "/api/v1/dl/worklist", T["nurse"])
        check(s == 200 and wl["items"] and {i["ward_code"] for i in wl["items"]} == {"4A"}, "Nurse worklist shows only ward 4A patients", wl)
        s, wl_out = api.call("GET", "/api/v1/dl/worklist", T["outsider"])
        check(s == 200 and wl_out["items"] == [], "Unassigned nurse sees no patients")
        check(api.call("GET", f"/api/v1/dl/worklist?ward_id={ward['ward_id']}", T["outsider"])[0] == 403, "Unassigned nurse is refused ward 4A (403)")

        # ---------------------------------------------------------------- feature 5: EHR admit, idempotency
        s, beds = api.call("GET", "/api/v1/dl/beds", admin)
        free = next(b for b in beds if b["ward_code"] == "4A" and b["state"] == "AVAILABLE")
        visit, mrn, control = f"E2E{run.upper()}", f"MRN-E2E-{run}", f"A01-{run}"
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("A01", visit, f"4A^^{free['label']}", mrn, control=control), headers=hl7_auth)
        check(s == 200 and "MSA|AA|" in str(ack), f"HL7 A01 admits patient into {free['label']} (ACK AA)", ack)
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("A01", visit, f"4A^^{free['label']}", mrn, control=control), headers=hl7_auth)
        check("Duplicate" in str(ack), "Re-sent A01 (same MSH-10) is acknowledged, not re-processed", ack)
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("A01", f"X{run}", "NOWARD^^1", f"MRN-X-{run}"), headers=hl7_auth)
        check("MSA|AE|" in str(ack), "Unknown EHR location is quarantined with ACK AE", ack)

        def my_row() -> dict | None:
            _, data = api.call("GET", "/api/v1/dl/worklist", T["nurse"])
            return next((i for i in data["items"] if i["his_encounter_id"] == visit), None)

        row = my_row()
        check(row is not None and row["state"] == "NOT_STARTED" and row["bed_label"] == free["label"], "Admitted patient appears on the 4A worklist", row)

        # ---------------------------------------------------------------- feature 1: A16 starts the workflow
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("A16", visit, "4A^^", mrn, extra="PV2|||||||||20261113140000\r"), headers=hl7_auth)
        row = my_row()
        check("MSA|AA|" in str(ack) and row and row["state"] == "INITIATED" and row["source"] == "HL7_A16" and row["expected_discharge_at"],
              "A16 pending discharge starts the discharge with an expected date (no re-entry)", row)
        did = row["discharge_id"]

        def detail() -> dict:
            return api.call("GET", f"/api/v1/dl/discharges/{did}", T["cm"])[1]

        def move(key: str, target: str, reason: str | None = None) -> tuple[int, object]:
            return api.call("POST", f"/api/v1/dl/discharges/{did}/transition", T[key],
                            {"target_state": target, "expected_version": detail()["version"], "reason": reason})

        check(move("nurse", "MEDICALLY_CLEARED")[0] == 403, "Nurse cannot medically clear (physician-only)")
        check(move("doctor", "MEDICALLY_CLEARED")[0] == 200, "Doctor medically clears")
        s, stale = api.call("POST", f"/api/v1/dl/discharges/{did}/transition", T["nurse"], {"target_state": "TASKS_PENDING", "expected_version": 1})
        check(s == 409 and isinstance(stale, dict) and stale.get("code") == "VERSION_CONFLICT", "Stale screen update is refused (optimistic lock)", stale)
        check(move("nurse", "TASKS_PENDING")[0] == 200, "Nurse starts discharge tasks")
        d = detail()
        owners = {t["owner"] for t in d["tasks"]}
        check({"pharmacist@4A", "doctor@4A", "nurse@4A", "case_manager@4A"} <= owners, "Checklist fans out to named ward roles", owners)

        # ---------------------------------------------------------------- feature 3: blockers
        s, err = api.call("POST", f"/api/v1/dl/discharges/{did}/blockers", T["cm"], {"category": "POST_ACUTE_PLACEMENT", "description": "Awaiting SNF bed offer", "due_in_minutes": 240})
        check(s == 400 and err.get("code") == "EXTERNAL_PARTY_REQUIRED", "External blocker must name the outside party", err)
        s, blk = api.call("POST", f"/api/v1/dl/discharges/{did}/blockers", T["cm"], {"category": "POST_ACUTE_PLACEMENT", "description": "Awaiting SNF bed offer",
                                                                                    "external_party": "Maple Grove SNF", "due_in_minutes": 240})
        check(s == 201 and blk["side"] == "EXTERNAL", "Case manager records external SNF blocker (auto-creates owned task)", blk)
        row = my_row()
        check(row["top_blocker"] and row["top_blocker"]["external_party"] == "Maple Grove SNF" and row["external_blockers"] == 1,
              "Worklist shows the external blocker and party", row and row["top_blocker"])
        s, err = move("nurse", "READY_TO_DEPART")
        check(s == 409 and err.get("code") == "DISCHARGE_BLOCKED", "READY is refused while blockers/blocking tasks are open", err)

        # ---------------------------------------------------------------- feature 5: passive auto-completion
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("RDE^O11", visit, "4A^^", mrn, extra="RXE||APIXABAN5^Apixaban 5 mg\r"), headers=hl7_auth)
        meds = next(t for t in detail()["tasks"] if t["type"] == "MEDS_RECONCILIATION")
        check("Auto-completed 1" in str(ack) and meds["status"] == "DONE", "Pharmacy dispense (RDE) auto-completes med reconciliation", ack)

        # ---------------------------------------------------------------- feature 2: each role works its own queue
        summary = next(t for t in detail()["tasks"] if t["type"] == "DISCHARGE_SUMMARY")
        s, err = api.call("POST", f"/api/v1/dl/tasks/{summary['id']}/complete", T["cm"])
        check(s == 403, "Case manager cannot complete the physician's discharge-summary task", err)
        for key in ("doctor", "nurse", "cm"):
            _, queue = api.call("GET", "/api/v1/dl/tasks?mine=true", T[key])
            for task in [t for t in queue if t["discharge_id"] == did]:
                api.call("POST", f"/api/v1/dl/tasks/{task['id']}/claim", T[key])
                api.call("POST", f"/api/v1/dl/tasks/{task['id']}/complete", T[key])
        check(api.call("POST", f"/api/v1/dl/blockers/{blk['id']}/resolve", T["cm"], {"note": "SNF accepted, bed 14:00"})[0] == 200, "Case manager resolves SNF blocker")
        d = detail()
        open_left = [t["title"] for t in d["tasks"] if t["status"] in ("OPEN", "CLAIMED")]
        check(not open_left, "All tasks closed by their owning roles", open_left)
        check(move("nurse", "READY_TO_DEPART")[0] == 200, "Nurse marks READY TO DEPART")

        # ---------------------------------------------------------------- the 2 PM fever (defects 1 + 2)
        s, err = move("doctor", "CANCELLED_REVERSED")
        check(s == 400 and err.get("code") == "REASON_REQUIRED", "Reversal requires a reason", err)
        s, _ = move("doctor", "CANCELLED_REVERSED", "Temp 39.2C at 14:05 - sepsis workup")
        d = detail()
        check(s == 200 and d["state"] == "CANCELLED_REVERSED" and d["reversal_reason"] == "Temp 39.2C at 14:05 - sepsis workup",
              "Doctor reverses READY_TO_DEPART; reason stored", d.get("state"))
        _, beds = api.call("GET", "/api/v1/dl/beds", admin)
        check(next(b for b in beds if b["id"] == free["id"])["state"] == "OCCUPIED", "Bed stays OCCUPIED after reversal")
        _, inbox = api.call("GET", "/api/v1/dl/notifications?unread=true", T["nurse"])
        check(any(n["kind"] == "DISCHARGE_REVERSED" and n["severity"] == "CRITICAL" and n["entity_id"] == did for n in inbox),
              "Ward nurse receives CRITICAL reversal alert", [n["title"] for n in inbox][:3])
        check(any("DISCHARGE_CANCELLED_REVERSED" == e["reason_code"] for e in d["timeline"]), "Timeline/audit shows the reversal reason code")

        # ---------------------------------------------------------------- restart regenerates stale work
        s, restart = api.call("POST", "/api/v1/dl/discharges", T["nurse"], {"encounter_id": row["encounter_id"]})
        check(s == 201 and restart.get("restarted"), "Nurse restarts the discharge after recovery", restart)
        move("doctor", "MEDICALLY_CLEARED"); move("nurse", "TASKS_PENDING")
        redo = [t for t in detail()["tasks"] if t["type"] == "MEDS_RECONCILIATION" and t["status"] == "OPEN"]
        check(len(redo) == 1, "Med reconciliation must be redone after the reversal (stale work not reused)")

        # ---------------------------------------------------------------- A03 departure + turnover
        s, ack = api.call("POST", "/api/v1/integrations/hl7", raw=hl7("A03", visit, "4A^^", mrn), headers=hl7_auth)
        check("MSA|AA|" in str(ack) and detail()["state"] == "DEPARTED", "EHR discharge (A03) is authoritative: DEPARTED", ack)
        _, beds = api.call("GET", "/api/v1/dl/beds", admin)
        check(next(b for b in beds if b["id"] == free["id"])["state"] == "CLEANING", "Bed moves to CLEANING, not AVAILABLE")
        _, jobs = api.call("GET", "/api/v1/dl/cleaning", T["evs1"])
        job = next((j for j in jobs if j["bed_label"] == free["label"]), None)
        check(job is not None, "Housekeeping sees the cleaning job", jobs)
        check(api.call("POST", f"/api/v1/dl/cleaning/{job['id']}/accept", T["evs1"])[0] == 200, "EVS 1 accepts cleaning")
        s, err = api.call("POST", f"/api/v1/dl/cleaning/{job['id']}/verify", T["evs1"])
        check(s == 409 and err.get("code") == "SECOND_PERSON_REQUIRED", "Same person cannot verify their own cleaning", err)
        check(api.call("POST", f"/api/v1/dl/cleaning/{job['id']}/verify", T["evs2"])[0] == 200, "EVS 2 verifies cleaning")
        _, beds = api.call("GET", "/api/v1/dl/beds", admin)
        check(next(b for b in beds if b["id"] == free["id"])["state"] == "AVAILABLE", "Bed is AVAILABLE only after human verification")

        # ---------------------------------------------------------------- outcomes + audit
        _, metrics = api.call("GET", "/api/v1/dl/metrics", admin)
        check(metrics["ready_delay"]["departed"] >= 1 and any(b["category"] == "POST_ACUTE_PLACEMENT" and b["side"] == "EXTERNAL"
                                                                for b in metrics["blockers_by_category"]),
              "Metrics report cleared-to-departed delay and delay by blocker category", metrics)
        _, status_ = api.call("GET", "/api/v1/dl/integration/status", admin)
        check(status_["open_quarantine"] >= 1 and status_["events"], "Integration status shows message counts and quarantine", status_)
        s, _ = api.call("GET", "/api/v1/dl/integration/status", T["nurse"])
        check(s == 403, "Integration status is admin/ops only")

        # ---------------------------------------------------------------- UI routes through the web server
        for route in ("/", "/worklist", "/tasks", "/beds", "/notifications", "/integration", f"/discharges/{did}", "/resources", "/dashboard"):
            req = urllib.request.Request(api.base + route)
            with urllib.request.urlopen(req, timeout=20) as resp:
                check(resp.status == 200, f"Web route {route} serves")

        # ---------------------------------------------------------------- phase 2a: MLLP, Medicare IM, operability
        mllp_port = int(cfg.get("DL_MLLP_PORT") or 2576)
        visit2, mrn2 = f"MLLP{run.upper()}", f"MRN-MLLP-{run}"
        _, beds = api.call("GET", "/api/v1/dl/beds", admin)
        free2 = next(b for b in beds if b["ward_code"] == "4A" and b["state"] == "AVAILABLE")
        medicare_a01 = hl7("A01", visit2, f"4A^^{free2['label']}", mrn2, extra="IN1|1|MCR|00001|MEDICARE PART A||||||||||||MC\r")
        ack = mllp_send(mllp_port, medicare_a01)
        check("MSA|AA|" in ack, "Epic-style MLLP feed (TCP framing) admits a Medicare inpatient (ACK AA)", ack)
        _, wl = api.call("GET", "/api/v1/dl/worklist", T["cm"])
        row2 = next((i for i in wl["items"] if i["his_encounter_id"] == visit2), None)
        check(row2 is not None and row2["medicare"] and row2["next_task"] and "Important Message" in row2["next_task"]["title"],
              "Medicare admission auto-creates the Important Message task for case management", row2 and row2["next_task"])
        check("MSA|AA|" in mllp_send(mllp_port, hl7("A03", visit2, "4A^^", mrn2)), "MLLP A03 discharges the patient")
        status, _ = api.call("GET", "/ready")
        check(status == 200, "Readiness probe reports DB + schema ready")
        req = urllib.request.Request(api.base.replace(":3001", f":{cfg.get('DL_API_PORT') or 8001}") + "/metrics")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode()
        check("dl_up 1" in body and "dl_hl7_last_message_age_seconds" in body and "dl_http_requests_total" in body,
              "Prometheus metrics expose feed lag, work queues and RED metrics")
        status, feed = api.call("GET", "/api/v1/dl/feed-health", T["nurse"])
        check(status == 200 and feed["configured"] and not feed["stale"], "Feed health is visible to ward staff and live after traffic", feed)

        # ---------------------------------------------------------------- brute-force protection
        for _ in range(5):
            api.call("POST", "/api/v1/auth/login", form={"username": users["outsider"]["email"], "password": "wrong-password"})
        s, _ = api.call("POST", "/api/v1/auth/login", form={"username": users["outsider"]["email"], "password": staff_pw})
        check(s == 423, "Account locks after 5 failed sign-ins, even with the right password")
    finally:
        for u in users.values():
            api.call("DELETE", f"/api/v1/auth/users/{u['id']}", admin)

    failed = [label for ok, label in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
