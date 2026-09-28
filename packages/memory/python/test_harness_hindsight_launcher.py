"""Unit tests for the Hindsight launcher's egress and binding rails.

Run with: python -m unittest discover -s packages/memory/python
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
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


if __name__ == "__main__":
    unittest.main()
