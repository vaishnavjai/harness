"""Harness launcher for the vendored Hindsight memory engine.

HindsightSupervisor.ts runs this file with the bundled Python. It starts
``hindsight_api.main`` in-process with Harness' safety rails applied first:

* Loopback only. The engine binds 127.0.0.1; any other host is refused.
* Orphan guard. The engine shuts down when the supervising Harness process
  goes away: its stdin pipe reaches EOF (the parent died, however it died),
  or, on POSIX, the parent PID changes. Shutdown is graceful (SIGTERM, which
  lets Hindsight stop its embedded Postgres) with a hard exit deadline.
* Egress guard. Outbound sockets may reach loopback and the hosts listed in
  HARNESS_MEMORY_EGRESS_ALLOW (the user's own LLM / embeddings endpoints).
  Anything else fails before a DNS lookup or connection is attempted.
  uvloop/winloop are disabled so asyncio traffic goes through the guarded
  Python socket layer. Native code that opens its own sockets (libpq for the
  local database, Rust extensions) is outside this guard's reach.
* No ambient .env. Hindsight's upward .env discovery is disabled so a stray
  file cannot override the binding or the credentials Harness passes in.
* Local data. The embedded Postgres (pg0) data directory is pinned to
  HARNESS_MEMORY_PG_DATA_DIR.
"""

from __future__ import annotations

import errno
import ipaddress
import os
import signal
import socket
import sys
import threading
import time
from collections.abc import Iterable

LOOPBACK_HOST = "127.0.0.1"
LOG_PREFIX = "[harness-memory]"


def log(message: str) -> bool:
    """Write a line to stderr; False when nobody is reading any more."""
    try:
        print(f"{LOG_PREFIX} {message}", file=sys.stderr, flush=True)
        return True
    except (OSError, ValueError):
        return False


def detach_output() -> None:
    """Point stdout/stderr at devnull once the supervisor is gone.

    The pipes' reader died with the parent, so every later write raises
    BrokenPipeError -- including the prints in Hindsight's own signal handler,
    which would abort it before it stops the embedded Postgres.
    """
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
    except OSError:
        return
    for fd in (1, 2):
        try:
            os.dup2(devnull, fd)
        except OSError:
            pass
    os.close(devnull)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


# --------------------------------------------------------------------------
# Egress guard
# --------------------------------------------------------------------------


def parse_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def normalize_host(host: object) -> str:
    if isinstance(host, bytes):
        host = host.decode("idna", "ignore")
    text = str(host).strip().lower().rstrip(".")
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return text


def is_loopback_name(host: str) -> bool:
    return host == "localhost" or host.endswith(".localhost")


class EgressPolicy:
    """Decides which outbound destinations the memory engine may reach."""

    def __init__(self, allowed_hosts: Iterable[str]) -> None:
        self.allowed_hosts: set[str] = set()
        self.allowed_ips: set[str] = set()
        for raw in allowed_hosts:
            host = normalize_host(raw)
            if not host:
                continue
            address = parse_ip(host)
            if address is not None:
                self.allowed_ips.add(str(address))
            else:
                self.allowed_hosts.add(host)
        self._lock = threading.Lock()

    def host_allowed(self, host: object) -> bool:
        if host is None:
            return True  # getaddrinfo(None, port) resolves a local bind address
        name = normalize_host(host)
        if not name or is_loopback_name(name):
            return True
        address = parse_ip(name)
        if address is not None:
            return address.is_loopback or address.is_unspecified or str(address) in self.allowed_ips
        return name in self.allowed_hosts

    def address_allowed(self, address: object) -> bool:
        if not isinstance(address, tuple) or not address:
            return True  # AF_UNIX paths and other non-IP families
        host = normalize_host(address[0])
        ip = parse_ip(host)
        if ip is None:
            return self.host_allowed(host)
        with self._lock:
            return ip.is_loopback or str(ip) in self.allowed_ips

    def remember_resolved(self, host: object, results: list[tuple]) -> None:
        name = normalize_host(host) if host is not None else ""
        if not name or is_loopback_name(name) or parse_ip(name) is not None:
            return
        with self._lock:
            for *_, sockaddr in results:
                ip = parse_ip(normalize_host(sockaddr[0]))
                if ip is not None:
                    self.allowed_ips.add(str(ip))


def install_egress_guard(policy: EgressPolicy) -> None:
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_sendto = socket.socket.sendto

    def blocked(target: object) -> PermissionError:
        return PermissionError(errno.EACCES, f"Harness memory egress blocked: {target}")

    def guarded_getaddrinfo(host, port, *args, **kwargs):  # type: ignore[no-untyped-def]
        if not policy.host_allowed(host):
            raise socket.gaierror(socket.EAI_NONAME, f"Harness memory egress blocked: {host}")
        results = real_getaddrinfo(host, port, *args, **kwargs)
        policy.remember_resolved(host, results)
        return results

    def guarded_connect(self, address):  # type: ignore[no-untyped-def]
        if not policy.address_allowed(address):
            raise blocked(address[0])
        return real_connect(self, address)

    def guarded_connect_ex(self, address):  # type: ignore[no-untyped-def]
        if not policy.address_allowed(address):
            return errno.EACCES
        return real_connect_ex(self, address)

    def guarded_sendto(self, data, *args):  # type: ignore[no-untyped-def]
        address = args[-1] if args else None
        if not policy.address_allowed(address):
            raise blocked(address[0] if isinstance(address, tuple) else address)
        return real_sendto(self, data, *args)

    socket.getaddrinfo = guarded_getaddrinfo
    socket.socket.connect = guarded_connect  # type: ignore[method-assign]
    socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign]
    socket.socket.sendto = guarded_sendto  # type: ignore[method-assign]

    # uvloop/winloop open sockets in C, bypassing the guard; asyncio's selector
    # loop goes through socket.socket. Hindsight treats a failed import as
    # "not installed" and falls back to asyncio.
    sys.modules["uvloop"] = None  # type: ignore[assignment]
    sys.modules["winloop"] = None  # type: ignore[assignment]
    if sys.platform == "win32":
        import asyncio

        # The proactor loop connects through overlapped I/O, not socket.connect.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


# --------------------------------------------------------------------------
# Orphan guard
# --------------------------------------------------------------------------

_shutdown_started = threading.Event()
_original_parent = os.getppid()


def parent_gone() -> bool:
    return sys.platform != "win32" and os.getppid() != _original_parent


def request_shutdown(reason: str) -> None:
    if _shutdown_started.is_set():
        return
    _shutdown_started.set()
    if not log(f"{reason}; shutting down") or parent_gone():
        detach_output()
    grace = float(env("HARNESS_MEMORY_SHUTDOWN_GRACE_S", "20"))

    def hard_exit() -> None:
        time.sleep(grace)
        log("graceful shutdown timed out; exiting")
        os._exit(3)

    threading.Thread(target=hard_exit, name="harness-hard-exit", daemon=True).start()
    try:
        # Hindsight's own SIGTERM/SIGINT handler stops the embedded Postgres.
        signal.raise_signal(signal.SIGINT if sys.platform == "win32" else signal.SIGTERM)
    except (OSError, ValueError):
        os._exit(3)


def install_orphan_guard() -> None:
    watch = {part.strip() for part in env("HARNESS_MEMORY_PARENT_WATCH").split(",") if part.strip()}
    if "stdin" in watch:

        def watch_stdin() -> None:
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except (OSError, ValueError):
                pass
            request_shutdown("supervisor pipe closed")

        threading.Thread(target=watch_stdin, name="harness-stdin-watch", daemon=True).start()

    if "ppid" in watch and sys.platform != "win32":

        def watch_parent() -> None:
            while not _shutdown_started.is_set():
                time.sleep(1.0)
                if parent_gone():
                    request_shutdown("supervisor process exited")
                    return

        threading.Thread(target=watch_parent, name="harness-ppid-watch", daemon=True).start()


# --------------------------------------------------------------------------
# Embedded Postgres data directory
# --------------------------------------------------------------------------


def pin_pg0_data_dir(data_dir: str) -> None:
    try:
        import pg0 as pg0_module
    except ImportError:
        return  # external database configured; nothing to pin
    original = pg0_module.Pg0

    class HarnessPg0(original):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            if kwargs.get("data_dir") is None:
                kwargs["data_dir"] = data_dir
            super().__init__(*args, **kwargs)

    pg0_module.Pg0 = HarnessPg0


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def close_inherited_descriptors() -> None:
    """Close every descriptor above stdio that the parent leaked to us.

    Electron's Chromium opens its DevTools listening socket without
    close-on-exec, so it reaches every child. Holding it would keep that port
    bound for as long as the engine runs, even after Harness has quit.
    """
    for fd_dir in ("/proc/self/fd", "/dev/fd"):
        if not os.path.isdir(fd_dir):
            continue
        for name in os.listdir(fd_dir):
            if name.isdigit() and int(name) > 2:
                try:
                    os.close(int(name))
                except OSError:
                    pass
        return


def main() -> None:
    close_inherited_descriptors()
    host = env("HINDSIGHT_API_HOST", LOOPBACK_HOST)
    if host != LOOPBACK_HOST:
        log(f"refusing to bind {host!r}: the memory engine only listens on {LOOPBACK_HOST}")
        sys.exit(2)
    port = env("HINDSIGHT_API_PORT")
    if not port.isdigit() or not 0 < int(port) < 65536:
        log(f"invalid HINDSIGHT_API_PORT {port!r}")
        sys.exit(2)

    install_orphan_guard()
    allowed = [host for host in env("HARNESS_MEMORY_EGRESS_ALLOW").split(",") if host.strip()]
    install_egress_guard(EgressPolicy(allowed))

    pg_data_dir = env("HARNESS_MEMORY_PG_DATA_DIR")
    if pg_data_dir:
        os.makedirs(pg_data_dir, mode=0o700, exist_ok=True)
        pin_pg0_data_dir(pg_data_dir)

    import hindsight_api.main as hindsight_main

    # Discovered .env files are applied with override=True upstream; Harness
    # passes the complete configuration through the environment instead.
    hindsight_main.load_dotenv_for_entrypoint = lambda: None  # type: ignore[attr-defined]
    sys.argv = [sys.argv[0], "--host", LOOPBACK_HOST, "--port", port]
    hindsight_main.main()


if __name__ == "__main__":
    main()
