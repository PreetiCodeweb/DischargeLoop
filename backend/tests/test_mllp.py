"""MLLP framing (unit) and a real TCP round trip through the listener (integration)."""
from __future__ import annotations

import asyncio
import ipaddress
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.discharge import hl7, mllp

DB_URL = os.environ.get("DL_TEST_DATABASE_URL")


def test_extract_frames_handles_split_multiple_and_noise():
    buf = bytearray(b"noise" + mllp.frame("MSH|A") + mllp.frame("MSH|B")[:4])
    assert mllp.extract_frames(buf, 1024) == [b"MSH|A"]
    buf.extend(mllp.frame("MSH|B")[4:])  # second frame arrives split across TCP reads
    assert mllp.extract_frames(buf, 1024) == [b"MSH|B"] and buf == bytearray()


def test_extract_frames_rejects_oversized_frame():
    buf = bytearray(mllp.START + b"x" * 2048)
    with pytest.raises(mllp.FrameError):
        mllp.extract_frames(buf, 1024)


async def _exchange(port: int, payloads: list[str]) -> list[str]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    acks: list[str] = []
    for payload in payloads:
        writer.write(mllp.frame(payload))
        await writer.drain()
        data = await asyncio.wait_for(reader.readuntil(mllp.END + mllp.CR), timeout=10)
        acks.append(data[1:-2].decode())
    writer.close()
    return acks


def _run_server(handler_server: mllp.MllpServer, scenario):
    async def main():
        srv = await asyncio.start_server(handler_server.handle, "127.0.0.1", 0)
        port = srv.sockets[0].getsockname()[1]
        async with srv:
            return await scenario(port)
    return asyncio.run(main())


@pytest.mark.skipif(not DB_URL, reason="DL_TEST_DATABASE_URL not set")
def test_mllp_round_trip_acks_in_order_and_persists(monkeypatch):
    engine = create_engine(DB_URL, connect_args={"options": "-c search_path=medsync,dischargeloop,public"})
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def ingest(raw: str) -> str:
        with factory() as s:
            return hl7.ingest(s, raw)[1]

    monkeypatch.setattr(mllp, "_ingest_sync", ingest)
    control = uuid.uuid4().hex[:16]
    a01 = (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||ADT^A01|{control}|P|2.5.1\r"
           "PID|1||MRN-MLLP||Socket^Test\rPV1|1|I|NOWARD^^1" + "|" * 16 + f"V-{control}\r")
    server = mllp.MllpServer([ipaddress.ip_network("127.0.0.1/32")], 1 << 20, 30, 4)
    acks = _run_server(server, lambda port: _exchange(port, [a01, a01]))
    assert f"MSA|AE|{control}" in acks[0]        # unknown ward -> quarantined, but the message is acknowledged
    assert "Duplicate" in acks[1]                 # resend of the same MSH-10 is idempotent
    with factory() as s:
        assert s.execute(text("SELECT count(*) FROM dischargeloop.hl7_event_log WHERE message_control_id = :c"),
                         {"c": control}).scalar_one() == 1
    engine.dispose()


def test_mllp_refuses_sources_outside_allowed_networks():
    server = mllp.MllpServer([ipaddress.ip_network("10.99.0.0/16")], 1 << 20, 5, 4)

    async def scenario(port: int):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            writer.write(mllp.frame("MSH|^~\\&|X"))
            await writer.drain()
            return await asyncio.wait_for(reader.read(), timeout=5)
        except ConnectionResetError:
            return b""  # the server closed first; the kernel reports the pending write as a reset

    assert _run_server(server, scenario) == b""  # closed without processing or ACK


def test_mllp_database_failure_closes_without_ack(monkeypatch):
    def broken(_: str) -> str:
        raise OperationalError("SELECT 1", {}, Exception("database unavailable"))

    monkeypatch.setattr(mllp, "_ingest_sync", broken)
    server = mllp.MllpServer([ipaddress.ip_network("127.0.0.1/32")], 1 << 20, 5, 4)

    async def scenario(port: int):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(mllp.frame("MSH|^~\\&|EPIC|NSGH|DL|NSGH|20261112||ADT^A01|X1|P|2.5.1\r"))
        await writer.drain()
        return await asyncio.wait_for(reader.read(), timeout=5)

    assert _run_server(server, scenario) == b""  # no ACK => the interface engine resends after recovery
