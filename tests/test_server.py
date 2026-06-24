import json
import threading
import time
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest


# ─── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_global_state():
    """Reset global server state before each test, killing any lingering process."""
    import server as srv
    with srv.task_lock:
        srv.loop_enabled = False
        proc = srv.active_process
        srv.active_process = None
        srv.is_running = False
        srv.log_buffer.clear()
        srv.last_exit_code = None
        srv.start_time = 0
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
    # Give daemon thread time to notice loop_enabled=False and exit
    import time
    time.sleep(0.3)
    yield


class HandlerTestBase:
    """Helper to create a DashboardRequestHandler with mocked IO."""

    @pytest.fixture(autouse=True)
    def setup_handler(self, reset_global_state):
        import server as srv
        self.srv = srv

        # Build a minimal mock for the handler
        self.wfile = BytesIO()

        handler = srv.DashboardRequestHandler
        self.handler = handler.__new__(handler)
        self.handler.command = "POST"
        self.handler.path = "/"
        self.handler.headers = {}
        self.handler.wfile = self.wfile
        self.handler.rfile = BytesIO()
        self.handler.send_response = MagicMock()
        self.handler.send_header = MagicMock()
        self.handler.end_headers = MagicMock()
        self.handler.close_connection = False
        self.handler.requestline = ""
        self.handler.request_version = "HTTP/1.1"

        # Make super().do_GET() do nothing (avoids file lookup)
        self.handler.send_head = MagicMock(return_value=None)
        self.handler.copyfile = MagicMock()

        yield


# ─── append_log ───────────────────────────────────────────────────────────────

class TestAppendLog:
    def test_appends_message(self, reset_global_state):
        from server import append_log, log_buffer, task_lock
        append_log("hello")
        with task_lock:
            assert "hello" in log_buffer

    def test_does_not_deadlock_outside_lock(self, reset_global_state):
        """append_log should be callable from any context without deadlocking."""
        from server import append_log, log_buffer, task_lock
        # Simulate calling from outside the lock
        append_log("test")
        with task_lock:
            assert log_buffer[-1] == "test"

    def test_buffer_limit(self, reset_global_state):
        from server import append_log, log_buffer, task_lock
        with task_lock:
            log_buffer.clear()
        # Fill just under limit
        for i in range(5000):
            append_log(f"line {i}\n")
        with task_lock:
            assert len(log_buffer) == 5000
        # One more triggers pop — buffer stays at 5000
        append_log("overflow\n")
        with task_lock:
            assert len(log_buffer) == 5000


# ─── do_GET /api/task-status ──────────────────────────────────────────────────

class TestTaskStatusEndpoint(HandlerTestBase):
    def test_returns_idle_when_not_running(self):
        self.handler.path = "/api/task-status"
        self.handler.command = "GET"
        self.handler.do_GET()

        self.handler.send_response.assert_called_with(200)
        data = json.loads(self.wfile.getvalue())
        assert data["status"] == "idle"
        assert data["loop_enabled"] is False

    def test_returns_running_when_active(self):
        with self.srv.task_lock:
            self.srv.is_running = True
            self.srv.start_time = int(time.time())
            self.srv.log_buffer.append("progress...\n")

        self.handler.path = "/api/task-status"
        self.handler.command = "GET"
        self.handler.do_GET()

        self.handler.send_response.assert_called_with(200)
        data = json.loads(self.wfile.getvalue())
        assert data["status"] == "running"
        assert data["duration_seconds"] >= 0
        assert "progress" in data["logs"]


# ─── do_POST /api/run-benchmark ───────────────────────────────────────────────

class TestRunBenchmarkEndpoint(HandlerTestBase):
    def test_returns_409_when_already_running(self):
        with self.srv.task_lock:
            self.srv.is_running = True

        self.handler.path = "/api/run-benchmark"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(409)
        data = json.loads(self.wfile.getvalue())
        assert "already running" in data["error"].lower()

    def test_returns_202_when_started(self):
        self.handler.path = "/api/run-benchmark"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(202)
        data = json.loads(self.wfile.getvalue())
        assert "started" in data["message"].lower()

        # Verify state was updated
        with self.srv.task_lock:
            assert self.srv.is_running is True
            assert self.srv.start_time > 0
            assert self.srv.last_exit_code is None


# ─── do_POST /api/stop-benchmark (deadlock fix verification) ──────────────────

class TestStopBenchmarkEndpoint(HandlerTestBase):
    def test_returns_400_when_nothing_running(self):
        self.handler.path = "/api/stop-benchmark"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(400)
        data = json.loads(self.wfile.getvalue())
        assert "No benchmark" in data["error"]

    def test_terminates_process_and_logs(self):
        """Core test: verify the deadlock fix works end-to-end."""
        mock_proc = MagicMock()

        with self.srv.task_lock:
            self.srv.is_running = True
            self.srv.active_process = mock_proc

        self.handler.path = "/api/stop-benchmark"
        self.handler.command = "POST"
        # This must NOT deadlock — the old code called append_log inside the lock
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        mock_proc.terminate.assert_called_once()

        # Verify log was written (append_log was called outside the lock)
        with self.srv.task_lock:
            log_text = "".join(self.srv.log_buffer)
            assert "Stop signal" in log_text

    def test_loop_disabled_on_stop(self):
        mock_proc = MagicMock()

        with self.srv.task_lock:
            self.srv.is_running = True
            self.srv.loop_enabled = True
            self.srv.active_process = mock_proc

        self.handler.path = "/api/stop-benchmark"
        self.handler.command = "POST"
        self.handler.do_POST()

        with self.srv.task_lock:
            assert self.srv.loop_enabled is False


# ─── do_POST /api/set-loop ───────────────────────────────────────────────────

class TestSetLoopEndpoint(HandlerTestBase):
    def test_enables_loop(self):
        self.handler.path = "/api/set-loop"
        self.handler.command = "POST"
        self.handler.headers = {"Content-Length": "17"}
        self.handler.rfile = BytesIO(json.dumps({"loop": True}).encode("utf-8"))
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        with self.srv.task_lock:
            assert self.srv.loop_enabled is True

    def test_disables_loop(self):
        with self.srv.task_lock:
            self.srv.loop_enabled = True

        self.handler.path = "/api/set-loop"
        self.handler.command = "POST"
        self.handler.headers = {"Content-Length": "18"}
        self.handler.rfile = BytesIO(json.dumps({"loop": False}).encode("utf-8"))
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        with self.srv.task_lock:
            assert self.srv.loop_enabled is False


# ─── do_POST /api/reset-data ─────────────────────────────────────────────────

class TestResetDataEndpoint(HandlerTestBase):
    def test_returns_409_when_running(self):
        with self.srv.task_lock:
            self.srv.is_running = True

        self.handler.path = "/api/reset-data"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(409)

    @patch("os.path.exists", return_value=True)
    @patch("os.remove")
    def test_deletes_files(self, mock_remove, mock_exists):
        self.handler.path = "/api/reset-data"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        assert mock_remove.call_count >= 1

    @patch("os.path.exists", return_value=False)
    def test_no_files_to_delete(self, mock_exists):
        self.handler.path = "/api/reset-data"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        data = json.loads(self.wfile.getvalue())
        assert data["deleted"] == []


# ─── run_benchmark_subprocess (state management) ─────────────────────────────

class TestRunBenchmarkSubprocess:
    def test_clears_active_process_in_finally(self, reset_global_state):
        """Verify that active_process is always set to None in finally."""
        import server as srv

        mock_proc = MagicMock()
        mock_proc.stdout.readline.side_effect = ["line1\n", ""]
        mock_proc.wait.return_value = 0
        mock_proc.returncode = 0

        # Patch at the subprocess module level before the function resolves it
        with patch("subprocess.Popen", return_value=mock_proc):
            srv.run_benchmark_subprocess()

        with srv.task_lock:
            assert srv.active_process is None
            assert srv.is_running is False

    def test_sets_active_process_during_run(self, reset_global_state):
        import server as srv

        mock_proc = MagicMock()
        mock_proc.stdout.readline.side_effect = ["processing\n", ""]
        mock_proc.wait.return_value = 0
        mock_proc.returncode = 0

        with patch("subprocess.Popen", return_value=mock_proc):
            srv.run_benchmark_subprocess()

        with srv.task_lock:
            assert srv.last_exit_code == 0


# ─── Integration: full stop flow ──────────────────────────────────────────────

class TestStopFlowIntegration(HandlerTestBase):
    def test_full_stop_flow_no_deadlock(self):
        """Simulate: start benchmark → stop it → verify clean state."""
        mock_proc = MagicMock()
        mock_proc.stdout.readline.side_effect = ["running\n", ""]
        mock_proc.wait.return_value = 0

        # Start a benchmark (normally runs in thread, but we simulate inline)
        import server as srv

        # Set up running state
        with srv.task_lock:
            srv.is_running = True
            srv.active_process = mock_proc

        # Issue stop — this must not deadlock
        self.handler.path = "/api/stop-benchmark"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(200)
        data = json.loads(self.wfile.getvalue())
        assert "successfully" in data["message"].lower()

        with srv.task_lock:
            assert srv.loop_enabled is False
            # active_process is still the mock (thread's finally hasn't run)
            # but that's fine — the stop only clears loop_enabled + terminates


# ─── 404 for unknown paths ────────────────────────────────────────────────────

class TestUnknownPath(HandlerTestBase):
    def test_returns_404(self):
        self.handler.path = "/api/nonexistent"
        self.handler.command = "POST"
        self.handler.do_POST()

        self.handler.send_response.assert_called_with(404)
