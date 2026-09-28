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
* Private database. On POSIX the launcher runs that Postgres itself from pg0's
  unpacked binaries: no TCP listener, only a Unix socket in a 0700 folder, and
  the password never appears in any process's arguments (pg0 would put it on
  psql's command line, where other accounts can read it).
"""

from __future__ import annotations

import errno
import ipaddress
import os
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterable
from urllib.parse import quote, urlencode

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


# pg0 starts Postgres listening on 127.0.0.1 and then creates the database
# role by running psql with the password in its arguments, where any local
# account can read it (/proc/<pid>/cmdline) and log in as a superuser over TCP.
# On POSIX Harness therefore runs the server itself from pg0's unpacked
# binaries: no TCP listener at all, only a Unix socket in a 0700 directory,
# and the password travels only in a 0600 file (initdb) and the environment.

PRIVATE_PG_PORT = 5432  # names the socket file only; nothing listens on TCP
PRIVATE_PG_UNPACK_INSTANCE = "harness-memory-unpack"
PRIVATE_PG_SETTINGS = {
    # pg0's tuning and logging, so existing stores behave the same.
    "shared_buffers": "256MB",
    "work_mem": "64MB",
    "maintenance_work_mem": "512MB",
    "effective_cache_size": "1GB",
    "max_parallel_maintenance_workers": "4",
    "timezone": "UTC",
    "log_timezone": "UTC",
    "logging_collector": "on",
    "log_directory": "log",
    "log_filename": "postgresql-%Y-%m-%d.log",
    "log_rotation_age": "1d",
    "log_rotation_size": "100MB",
}
PRIVATE_PG_ENFORCED = {"listen_addresses": "", "unix_socket_permissions": "0700"}


def postgres_environment(installation: str | None = None, password: str | None = None) -> dict[str, str]:
    """The engine's environment without ambient libpq settings (PGHOST, ...).

    The unpacked binaries load their bundled ICU from the installation's lib
    folder, which pg0 also puts on LD_LIBRARY_PATH.
    """
    result = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    if installation is not None:
        library = os.path.join(installation, "lib")
        inherited = result.get("LD_LIBRARY_PATH")
        result["LD_LIBRARY_PATH"] = f"{library}{os.pathsep}{inherited}" if inherited else library
    if password is not None:
        result["PGPASSWORD"] = password
    return result


def find_postgres_installation(home: str, major: str | None = None) -> str | None:
    """The newest unpacked pg0 installation that includes pgvector."""
    root = os.path.join(home, ".pg0", "installation")
    try:
        versions = sorted(os.listdir(root), reverse=True)
    except OSError:
        return None
    for version in versions:
        if major and version.split(".")[0] != major:
            continue
        base = os.path.join(root, version)
        if os.path.isfile(os.path.join(base, "bin", "pg_ctl")) and os.path.isfile(
            os.path.join(base, "share", "extension", "vector.control")
        ):
            return base
    return None


def run_quiet(argv: list[str], *, env: dict[str, str], input_text: str | None = None, timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - fixed binaries, no shell
        argv, env=env, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, check=False
    )


def unpack_postgres(pg0_binary: str, home: str) -> None:
    """Have pg0 unpack Postgres and pgvector without ever serving on TCP.

    pg0 has no unpack-only command, so this starts a throwaway cluster under a
    throwaway password with TCP disabled. pg0's own role setup then fails
    (it connects over TCP), after unpacking. The cluster is deleted at once.
    """
    scratch = tempfile.mkdtemp(prefix="harness-pg-unpack-")
    data = os.path.join(scratch, "data")
    env = postgres_environment()
    try:
        run_quiet(
            [
                pg0_binary, "start", "--name", PRIVATE_PG_UNPACK_INSTANCE, "--data-dir", data,
                "--username", "postgres", "--password", secrets.token_urlsafe(24), "--database", "postgres",
                "-c", "listen_addresses=", "-c", f"unix_socket_directories={scratch}", "-c", "unix_socket_permissions=0700",
            ],
            env=env,
            timeout=300,
        )
    finally:
        installation = find_postgres_installation(home)
        if installation and os.path.isfile(os.path.join(data, "postmaster.pid")):
            run_quiet([os.path.join(installation, "bin", "pg_ctl"), "stop", "--pgdata", data, "--mode", "immediate", "--wait"],
                      env=postgres_environment(installation), timeout=60)
        shutil.rmtree(scratch, ignore_errors=True)
        shutil.rmtree(os.path.join(home, ".pg0", "instances", PRIVATE_PG_UNPACK_INSTANCE), ignore_errors=True)


def pg_ctl_options(socket_dir: str, config: dict[str, str]) -> str:
    """postgres options for pg_ctl -o, which runs them through /bin/sh."""
    settings = {**PRIVATE_PG_SETTINGS, **config, "unix_socket_directories": socket_dir, **PRIVATE_PG_ENFORCED}
    parts = ["-p", str(PRIVATE_PG_PORT)]
    for key, value in settings.items():
        parts += ["-c", shlex.quote(f"{key}={value}")]
    return " ".join(parts)


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

        if sys.platform != "win32":
            # Windows keeps pg0's own lifecycle: its process arguments are not
            # readable by other accounts, and asyncpg has no Unix sockets there.

            def _socket_dir(self) -> str:  # type: ignore[no-untyped-def]
                value = (self.config or {}).get("unix_socket_directories", "").strip()
                if not value:
                    raise pg0_module.Pg0Error("Harness memory requires a private socket directory")
                return value

            def _installation(self, unpack: bool) -> str:  # type: ignore[no-untyped-def]
                home = os.path.expanduser("~")
                major = None
                try:
                    with open(os.path.join(self.data_dir, "PG_VERSION"), encoding="utf-8") as handle:
                        major = handle.read().strip()
                except OSError:
                    pass
                found = find_postgres_installation(home, major)
                if found is None and unpack:
                    unpack_postgres(pg0_module._find_pg0(), home)
                    found = find_postgres_installation(home, major)
                if found is None:
                    raise pg0_module.Pg0Error("Embedded PostgreSQL could not be unpacked")
                return found

            def _uri(self) -> str:  # type: ignore[no-untyped-def]
                query = urlencode({"host": self._socket_dir(), "port": str(PRIVATE_PG_PORT)})
                user = quote(self.username, safe="")
                password = quote(self.password, safe="")
                return f"postgresql://{user}:{password}@/{quote(self.database, safe='')}?{query}"

            def _running(self, installation: str) -> bool:  # type: ignore[no-untyped-def]
                status = run_quiet([os.path.join(installation, "bin", "pg_ctl"), "status", "--pgdata", self.data_dir],
                                   env=postgres_environment(installation), timeout=30)
                return status.returncode == 0

            def start(self):  # type: ignore[no-untyped-def]
                socket_dir = self._socket_dir()
                os.makedirs(socket_dir, mode=0o700, exist_ok=True)
                os.chmod(socket_dir, 0o700)
                installation = self._installation(unpack=True)
                bin_dir = os.path.join(installation, "bin")
                pg_ctl = os.path.join(bin_dir, "pg_ctl")
                env = postgres_environment(installation)
                if not os.path.isfile(os.path.join(self.data_dir, "PG_VERSION")):
                    # The bootstrap superuser is the engine's own role; its
                    # password is read from a private file, never an argument.
                    fd, pwfile = tempfile.mkstemp(dir=socket_dir, prefix=".pwfile-")
                    try:
                        os.fchmod(fd, 0o600)
                        with os.fdopen(fd, "w", encoding="utf-8") as handle:
                            handle.write(self.password + "\n")
                        result = run_quiet(
                            [os.path.join(bin_dir, "initdb"), "--pgdata", self.data_dir, "--username", self.username,
                             "--pwfile", pwfile, "--auth", "scram-sha-256", "--encoding", "UTF8"],
                            env=env,
                        )
                    finally:
                        os.unlink(pwfile)
                    if result.returncode != 0:
                        raise pg0_module.Pg0Error(f"initdb failed: {result.stderr.strip()[-500:]}")
                if not self._running(installation):
                    result = run_quiet(
                        [pg_ctl, "start", "--pgdata", self.data_dir, "--wait", "--timeout", "60",
                         "--log", os.path.join(self.data_dir, "start.log"), "-o", pg_ctl_options(socket_dir, dict(self.config or {}))],
                        env=env,
                    )
                    if result.returncode != 0:
                        raise pg0_module.Pg0Error(f"PostgreSQL did not start: {result.stderr.strip()[-500:]}")
                # Idempotent, and carries no secret: a start interrupted after
                # initdb still ends with the engine's database.
                name = self.database.replace('"', '""')
                owner = self.username.replace('"', '""')
                literal = self.database.replace("'", "''")
                result = run_quiet(
                    [os.path.join(bin_dir, "psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", socket_dir,
                     "-p", str(PRIVATE_PG_PORT), "-U", self.username, "-d", "postgres"],
                    env=postgres_environment(installation, self.password),
                    input_text=f"SELECT 'CREATE DATABASE \"{name}\" OWNER \"{owner}\"' "
                    f"WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{literal}')\\gexec\n",
                )
                if result.returncode != 0:
                    raise pg0_module.Pg0Error(f"PostgreSQL database setup failed: {result.stderr.strip()[-500:]}")
                return self.info()

            def stop(self) -> None:  # type: ignore[no-untyped-def]
                installation = find_postgres_installation(os.path.expanduser("~"))
                if installation is None or not os.path.isfile(os.path.join(self.data_dir, "postmaster.pid")):
                    return
                run_quiet([os.path.join(installation, "bin", "pg_ctl"), "stop", "--pgdata", self.data_dir,
                           "--mode", "fast", "--wait", "--timeout", "60"], env=postgres_environment(installation))

            def info(self):  # type: ignore[no-untyped-def]
                installation = find_postgres_installation(os.path.expanduser("~"))
                running = installation is not None and self._running(installation)
                return pg0_module.InstanceInfo(
                    name=self.name, running=running, port=PRIVATE_PG_PORT, username=self.username,
                    database=self.database, data_dir=self.data_dir, uri=self._uri() if running else None,
                )

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
