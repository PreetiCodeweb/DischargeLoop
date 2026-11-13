"""Native MLLP / MLLPS listener for direct Epic Bridges (or interface-engine) HL7 v2 feeds.

Bridges keeps one long-lived TCP connection per interface and sends messages in order, waiting for each ACK.
Design choices that follow from that:
- Messages on a connection are processed strictly sequentially (order matters for ADT).
- A message is ACKed only after it is durably processed. On a database failure the connection is closed
  without an ACK so the sender retries — never ACK AA for something that was not stored.
- MLLP has no authentication: access is restricted by source network (hospital VPN CIDRs) and optional
  mutual TLS (MLLPS with a client CA), configured per deployment.
Run: python -m app.discharge.mllp   (env: MLLP_HOST, MLLP_PORT, MLLP_ALLOWED_CIDRS, MLLP_TLS_CERT/KEY/CLIENT_CA, ...)
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import signal
import ssl

from sqlalchemy.exc import SQLAlchemyError

from app.database.session import SessionLocal
from app.discharge import hl7

START, END, CR = b"\x0b", b"\x1c", b"\x0d"
log = logging.getLogger("dischargeloop.mllp")


class FrameError(Exception):
    pass


def extract_frames(buffer: bytearray, max_bytes: int) -> list[bytes]:
    """Pop every complete <VT>message<FS><CR> frame from the buffer (in place). Bytes before <VT> are discarded."""
    frames: list[bytes] = []
    while True:
        start = buffer.find(START)
        if start < 0:
            buffer.clear()  # no frame start: line noise / keepalive bytes
            return frames
        if start:
            del buffer[:start]
        end = buffer.find(END + CR)
        if end < 0:
            if len(buffer) > max_bytes:
                raise FrameError(f"frame exceeds {max_bytes} bytes")
            return frames
        frames.append(bytes(buffer[1:end]))
        del buffer[:end + 2]


def frame(payload: str) -> bytes:
    return START + payload.encode("utf-8") + END + CR


def _ingest_sync(raw: str) -> str:
    db = SessionLocal()
    try:
        return hl7.ingest(db, raw)[1]
    finally:
        db.close()


class MllpServer:
    def __init__(self, allowed: list[ipaddress._BaseNetwork], max_bytes: int, idle_timeout: float, max_connections: int) -> None:
        self.allowed, self.max_bytes, self.idle_timeout = allowed, max_bytes, idle_timeout
        self.slots = asyncio.Semaphore(max_connections)

    def _permitted(self, peer: str) -> bool:
        try:
            address = ipaddress.ip_address(peer)
        except ValueError:
            return False
        return any(address in network for network in self.allowed)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = (writer.get_extra_info("peername") or ("?", 0))[0]
        if not self._permitted(peer):
            log.warning("mllp connection refused from %s (not in MLLP_ALLOWED_CIDRS)", peer)
            writer.close()
            return
        if self.slots.locked():
            log.warning("mllp connection limit reached; refusing %s", peer)
            writer.close()
            return
        async with self.slots:
            log.info("mllp connection from %s", peer)
            buffer = bytearray()
            try:
                while True:
                    chunk = await asyncio.wait_for(reader.read(65536), timeout=self.idle_timeout)
                    if not chunk:
                        break
                    buffer.extend(chunk)
                    for payload in extract_frames(buffer, self.max_bytes):
                        try:
                            ack = await asyncio.to_thread(_ingest_sync, payload.decode("utf-8", errors="replace"))
                        except SQLAlchemyError as exc:
                            # Durability first: no ACK, drop the connection, the sender will retry this message.
                            log.error("mllp database error (%s); closing without ACK so the sender retries", type(exc).__name__)
                            return
                        writer.write(frame(ack))
                        await writer.drain()
            except asyncio.TimeoutError:
                log.info("mllp idle timeout for %s", peer)
            except FrameError as exc:
                log.warning("mllp framing error from %s: %s", peer, exc)
                writer.write(frame(hl7.ack(None, "AR", str(exc))))
            except (ConnectionError, asyncio.IncompleteReadError):
                log.info("mllp connection reset by %s", peer)
            finally:
                writer.close()


def _tls_context() -> ssl.SSLContext | None:
    cert, key = os.environ.get("MLLP_TLS_CERT"), os.environ.get("MLLP_TLS_KEY")
    if not cert:
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    if client_ca := os.environ.get("MLLP_TLS_CLIENT_CA"):
        ctx.load_verify_locations(client_ca)
        ctx.verify_mode = ssl.CERT_REQUIRED  # mutual TLS: only the hospital's interface engine certificate
    return ctx


async def serve() -> None:
    allowed = [ipaddress.ip_network(c.strip()) for c in
               os.environ.get("MLLP_ALLOWED_CIDRS", "127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16").split(",") if c.strip()]
    server = MllpServer(allowed, int(os.environ.get("MLLP_MAX_BYTES", "1048576")),
                        float(os.environ.get("MLLP_IDLE_TIMEOUT_SECONDS", "900")), int(os.environ.get("MLLP_MAX_CONNECTIONS", "32")))
    tls = _tls_context()
    host, port = os.environ.get("MLLP_HOST", "0.0.0.0"), int(os.environ.get("MLLP_PORT", "2575"))
    srv = await asyncio.start_server(server.handle, host, port, ssl=tls, limit=2 ** 20)
    log.info("mllp%s listening on %s:%d (allowed: %s)", "s" if tls else "", host, port, ", ".join(map(str, allowed)))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with srv:
        await stop.wait()
    log.info("mllp listener stopped")


if __name__ == "__main__":
    from app.core.observability import configure_logging
    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(serve())
