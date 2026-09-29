"""Unit tests for the Hindsight launcher's egress and binding rails.

Run with: python -m unittest discover -s packages/memory/python
"""

from __future__ import annotations

import importlib.util
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import harness_hindsight_launcher as launcher  # noqa: E402


class EgressPolicyTests(unittest.TestCase):
    def test_loopback_is_always_allowed(self) -> None:
        policy = launcher.EgressPolicy([])
        for host in ("127.0.0.1", "127.8.9.10", "::1", "localhost", "api.localhost", None):
            self.assertTrue(policy.host_allowed(host), host)
        self.assertTrue(policy.address_allowed(("127.0.0.1", 5432)))
        self.assertTrue(policy.address_allowed(("::ffff:127.0.0.1", 5432, 0, 0)))
        self.assertTrue(policy.address_allowed("/tmp/.s.PGSQL.5432"))

    def test_unlisted_hosts_and_addresses_are_blocked(self) -> None:
        policy = launcher.EgressPolicy(["api.openai.com"])
        self.assertFalse(policy.host_allowed("telemetry.example.com"))
        self.assertFalse(policy.host_allowed("8.8.8.8"))
        self.assertFalse(policy.address_allowed(("8.8.8.8", 443)))
        self.assertFalse(policy.address_allowed(("2001:4860:4860::8888", 443, 0, 0)))

    def test_listed_hosts_allow_the_addresses_they_resolve_to(self) -> None:
        policy = launcher.EgressPolicy(["LLM.Internal.", "10.0.0.7"])
        self.assertTrue(policy.host_allowed("llm.internal"))
        self.assertTrue(policy.address_allowed(("10.0.0.7", 8000)))
        self.assertFalse(policy.address_allowed(("10.0.0.8", 8000)))
        policy.remember_resolved("llm.internal", [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 8000))])
        self.assertTrue(policy.address_allowed(("10.0.0.8", 8000)))
        # Resolutions of loopback names never widen the allowlist.
        policy.remember_resolved("localhost", [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.9.9.9", 80))])
        self.assertFalse(policy.address_allowed(("10.9.9.9", 80)))


class GuardedSocketTests(unittest.TestCase):
    """The guard patches process-global socket functions, so run it in a child."""

    def run_child(self, code: str) -> subprocess.CompletedProcess[str]:
        program = (
            "import sys; sys.path.insert(0, %r)\n"
            "import harness_hindsight_launcher as l\n"
            "l.install_egress_guard(l.EgressPolicy(['allowed.invalid']))\n" % str(Path(__file__).resolve().parent)
        ) + code
        return subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, timeout=30)

    def test_blocked_dns_lookup_never_leaves_the_process(self) -> None:
        result = self.run_child(
            "import socket\n"
            "try:\n"
            "    socket.getaddrinfo('example.org', 443)\n"
            "except socket.gaierror as e:\n"
            "    print('blocked', 'egress blocked' in str(e))\n"
        )
        self.assertEqual(result.stdout.strip(), "blocked True", result.stderr)

    def test_blocked_connect_raises_permission_error(self) -> None:
        result = self.run_child(
            "import socket\n"
            "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
            "try:\n"
            "    s.connect(('192.0.2.10', 443))\n"
            "except PermissionError as e:\n"
            "    print('blocked')\n"
            "print(s.connect_ex(('192.0.2.10', 443)) != 0)\n"
        )
        self.assertEqual(result.stdout.split(), ["blocked", "True"], result.stderr)

    def test_loopback_connect_is_allowed(self) -> None:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        accepted = threading.Thread(target=lambda: server.accept()[0].close(), daemon=True)
        accepted.start()
        try:
            result = self.run_child(
                "import socket\n"
                f"socket.create_connection(('127.0.0.1', {port}), timeout=5).close()\n"
                "print('connected')\n"
            )
        finally:
            server.close()
        self.assertEqual(result.stdout.strip(), "connected", result.stderr)

    def test_event_loop_accelerators_are_disabled(self) -> None:
        result = self.run_child(
            "try:\n"
            "    import uvloop\n"
            "except ImportError:\n"
            "    print('disabled')\n"
        )
        self.assertEqual(result.stdout.strip(), "disabled", result.stderr)


class OrphanGuardTests(unittest.TestCase):
    """The stdin watcher must notice a closed supervisor pipe without ever blocking a read on it."""

    CHILD = (
        "import os, signal, sys, time\n"
        "sys.path.insert(0, %r)\n"
        "import harness_hindsight_launcher as l\n"
        "signal.signal(signal.SIGINT, lambda *a: os._exit(0))\n"
        "signal.signal(signal.SIGTERM, lambda *a: os._exit(0))\n"
        "l.install_orphan_guard()\n"
        "%s\n"
        "print('loaded', flush=True)\n"
        "time.sleep(60)\n"
    )

    def start_child(self, body: str = "") -> subprocess.Popen[str]:
        program = self.CHILD % (str(Path(__file__).resolve().parent), body)
        env = {**os.environ, "HARNESS_MEMORY_PARENT_WATCH": "stdin", "HARNESS_MEMORY_SHUTDOWN_GRACE_S": "10"}
        child = subprocess.Popen(
            [sys.executable, "-c", program], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env,
        )
        self.addCleanup(self.reap, child)
        return child

    @staticmethod
    def reap(child: subprocess.Popen[str]) -> None:
        child.kill()
        child.wait(timeout=20)
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream:
                stream.close()

    def loaded(self, child: subprocess.Popen[str], timeout: float = 20) -> None:
        """Wait for the child to report it finished loading; fail rather than hang."""
        line: list[str] = []
        reader = threading.Thread(target=lambda: line.append(child.stdout.readline().strip()), daemon=True)
        reader.start()
        reader.join(timeout)
        self.assertEqual(line, ["loaded"], f"the child did not finish loading within {timeout}s")

    def test_shuts_down_when_the_supervisor_closes_the_pipe(self) -> None:
        child = self.start_child()
        self.loaded(child)
        time.sleep(0.6)
        self.assertIsNone(child.poll(), "the engine must stay up while the supervisor holds the pipe")
        child.stdin.close()
        self.assertEqual(child.wait(timeout=20), 0)
        self.assertIn("supervisor pipe closed", child.stderr.read())

    def test_data_written_to_the_pipe_is_not_a_shutdown(self) -> None:
        child = self.start_child()
        self.loaded(child)
        child.stdin.write("x" * 10_000)
        child.stdin.flush()
        time.sleep(0.8)
        self.assertIsNone(child.poll())

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "needs numpy, whose native extensions the hang showed up on")
    @unittest.skipUnless(sys.platform == "win32", "a blocked pipe read only stalls the loader on Windows")
    def test_loading_native_extensions_is_not_blocked_by_the_watcher(self) -> None:
        # A blocking stdin read on another thread once made `import numpy` wait
        # until the pipe closed, so the engine never started.
        child = self.start_child("time.sleep(0.5); import numpy")
        self.loaded(child, timeout=20)
        self.assertIsNone(child.poll())


class Utf8OutputTests(unittest.TestCase):
    def test_piped_output_survives_characters_the_ansi_code_page_lacks(self) -> None:
        # Hindsight prints a banner drawn with U+2584; cp1252 cannot encode it.
        program = (
            "import sys; sys.path.insert(0, %r)\n"
            "import harness_hindsight_launcher as l\n"
            "l.use_utf8_output()\n"
            "print('\\u2584 banner')\n"
            "print('\\u2584 log', file=sys.stderr)\n" % str(Path(__file__).resolve().parent)
        )
        result = subprocess.run(
            [sys.executable, "-c", program], capture_output=True, timeout=30,
            env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout.decode("utf-8").strip(), "▄ banner")
        self.assertEqual(result.stderr.decode("utf-8").strip(), "▄ log")


@unittest.skipIf(sys.platform == "win32", "closes POSIX descriptors; the launcher does nothing on Windows")
class InheritedDescriptorTests(unittest.TestCase):
    def test_closes_descriptors_the_parent_leaked(self):
        import socket
        import subprocess
        import textwrap

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        os.set_inheritable(listener.fileno(), True)
        script = textwrap.dedent(
            f"""
            import os, sys
            sys.path.insert(0, {os.path.dirname(os.path.abspath(__file__))!r})
            import harness_hindsight_launcher as launcher
            before = os.path.exists("/proc/self/fd/{listener.fileno()}") or os.path.exists("/dev/fd/{listener.fileno()}")
            launcher.close_inherited_descriptors()
            try:
                os.fstat({listener.fileno()})
                after = True
            except OSError:
                after = False
            print(before, after)
            """
        )
        try:
            result = subprocess.run(
                [sys.executable, "-c", script],
                pass_fds=(listener.fileno(),),
                capture_output=True,
                text=True,
                check=True,
            )
        finally:
            listener.close()
        self.assertEqual(result.stdout.split(), ["True", "False"])


class BindingTests(unittest.TestCase):
    def test_refuses_non_loopback_host(self) -> None:
        env = {**os.environ, "HINDSIGHT_API_HOST": "0.0.0.0", "HINDSIGHT_API_PORT": "8888"}
        result = subprocess.run(
            [sys.executable, str(Path(launcher.__file__).resolve())],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("refusing to bind", result.stderr)

    def test_rejects_invalid_port(self) -> None:
        env = {**os.environ, "HINDSIGHT_API_HOST": "127.0.0.1", "HINDSIGHT_API_PORT": "70000"}
        result = subprocess.run(
            [sys.executable, str(Path(launcher.__file__).resolve())],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid HINDSIGHT_API_PORT", result.stderr)


class PrivatePostgresOptionTests(unittest.TestCase):
    def test_tcp_stays_off_even_when_the_url_asks_for_it(self) -> None:
        options = launcher.pg_ctl_options("/data/run", {"listen_addresses": "*", "unix_socket_permissions": "0777"})
        words = shlex.split(options)
        self.assertIn("listen_addresses=", words)
        self.assertNotIn("listen_addresses=*", words)
        self.assertIn("unix_socket_permissions=0700", words)
        self.assertNotIn("unix_socket_permissions=0777", words)

    def test_socket_folders_with_spaces_or_quotes_survive_the_shell(self) -> None:
        folder = "/Users/a b/Library/Application Support/Harness/it's/run"
        words = shlex.split(launcher.pg_ctl_options(folder, {"unix_socket_directories": "/tmp"}))
        self.assertIn(f"unix_socket_directories={folder}", words)
        self.assertNotIn("unix_socket_directories=/tmp", words)

    def test_environment_drops_ambient_libpq_settings_and_passes_the_password_privately(self) -> None:
        previous = {name: os.environ.get(name) for name in ("PGHOST", "PGPASSWORD", "LD_LIBRARY_PATH")}
        os.environ.update({"PGHOST": "attacker.example", "PGPASSWORD": "ambient", "LD_LIBRARY_PATH": "/opt/lib"})
        try:
            env = launcher.postgres_environment("/install", "secret")
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        self.assertNotIn("PGHOST", env)
        self.assertEqual(env["PGPASSWORD"], "secret")
        self.assertEqual(env["LD_LIBRARY_PATH"], f"{os.path.join('/install', 'lib')}{os.pathsep}/opt/lib")
        self.assertNotIn("PGPASSWORD", launcher.postgres_environment("/install"))

    def test_installation_needs_pgvector_and_matches_the_cluster_version(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            root = Path(home, ".pg0", "installation")
            for version, vector in (("17.2.0", True), ("18.1.0", False)):
                Path(root, version, "bin").mkdir(parents=True)
                Path(root, version, "bin", "pg_ctl").write_text("")
                if vector:
                    Path(root, version, "share", "extension").mkdir(parents=True)
                    Path(root, version, "share", "extension", "vector.control").write_text("")
            self.assertEqual(launcher.find_postgres_installation(home), str(Path(root, "17.2.0")))
            self.assertIsNone(launcher.find_postgres_installation(home, "18"))
            self.assertIsNone(launcher.find_postgres_installation(str(Path(home, "missing"))))


def pg0_available() -> bool:
    try:
        import pg0  # noqa: F401
    except ImportError:
        return False
    return sys.platform != "win32" and hasattr(os, "geteuid") and os.geteuid() != 0


@unittest.skipUnless(pg0_available(), "needs pg0 and a non-root POSIX account (Postgres refuses root)")
class PrivatePostgresTests(unittest.TestCase):
    """Starts the real embedded Postgres through the launcher's pg0 override."""

    def test_socket_only_server_whose_password_never_reaches_a_command_line(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            password = "Launcher-Test-" + os.urandom(12).hex()
            home, data, run = (os.path.join(root, name) for name in ("home", "postgres", "run"))
            os.makedirs(home, mode=0o700)
            previous_home = os.environ.get("HOME")
            os.environ["HOME"] = home
            hits: list[str] = []
            stop = threading.Event()

            def watch() -> None:
                me = str(os.getpid())
                while not stop.is_set():
                    for pid in os.listdir("/proc") if os.path.isdir("/proc") else []:
                        if not pid.isdigit() or pid == me:
                            continue
                        try:
                            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                                if password.encode() in handle.read():
                                    hits.append(pid)
                        except OSError:
                            pass
                    time.sleep(0.005)

            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            import pg0

            original = pg0.Pg0
            try:
                launcher.pin_pg0_data_dir(data)
                engine = pg0.Pg0(name="harness-memory", username="hindsight", password=password, database="hindsight",
                                 config={"unix_socket_directories": run, "unix_socket_permissions": "0700"})
                self.assertFalse(engine.info().running)
                info = engine.start()
                try:
                    self.assertTrue(info.running)
                    self.assertTrue(info.uri.startswith("postgresql://hindsight:"))
                    query = launcher.postgres_environment(launcher.find_postgres_installation(home), password)
                    result = subprocess.run(
                        [os.path.join(launcher.find_postgres_installation(home) or "", "bin", "psql"), "-X", "-At",
                         "-h", run, "-U", "hindsight", "-d", "hindsight", "-c", "show listen_addresses"],
                        env=query, capture_output=True, text=True, timeout=30, check=True,
                    )
                    self.assertEqual(result.stdout.strip(), "")
                    self.assertEqual(os.stat(run).st_mode & 0o777, 0o700)
                    # A second start on the running store is a no-op.
                    self.assertTrue(pg0.Pg0(name="harness-memory", username="hindsight", password=password,
                                            database="hindsight", config={"unix_socket_directories": run}).start().running)
                finally:
                    engine.stop()
                self.assertFalse(engine.info().running)
            finally:
                stop.set()
                watcher.join()
                pg0.Pg0 = original
                if previous_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = previous_home
            self.assertEqual(hits, [], "the database password appeared in a process's arguments")


if __name__ == "__main__":
    unittest.main()
