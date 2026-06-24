import os
import sys
import json
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, HTTPServer

# Global task state
task_lock = threading.Lock()
is_running = False
loop_enabled = False
log_buffer = []
last_exit_code = None
start_time = 0
active_process = None

class DashboardRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for local convenience
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        global is_running, log_buffer, last_exit_code, start_time

        if self.path == '/api/task-status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            with task_lock:
                duration = 0
                if is_running and start_time > 0:
                    duration = int(time.time() - start_time)
                
                status_data = {
                    "status": "running" if is_running else "idle",
                    "loop_enabled": loop_enabled,
                    "duration_seconds": duration,
                    "exit_code": last_exit_code,
                    "logs": "".join(log_buffer)
                }
            self.wfile.write(json.dumps(status_data).encode('utf-8'))
            return

        # Fallback to standard static file serving
        super().do_GET()

    def do_POST(self):
        global is_running, log_buffer, last_exit_code, start_time, loop_enabled

        if self.path == '/api/run-benchmark':
            with task_lock:
                if is_running:
                    self.send_response(409)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Benchmark is already running."}).encode('utf-8'))
                    return
                
                # Reset log buffer and start task
                is_running = True
                log_buffer.clear()
                last_exit_code = None
                start_time = time.time()
                
                # Start background thread
                thread = threading.Thread(target=run_benchmark_subprocess)
                thread.daemon = True
                thread.start()

            self.send_response(202)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"message": "Benchmark run started successfully."}).encode('utf-8'))
            return

        if self.path == '/api/set-loop':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                with task_lock:
                    loop_enabled = bool(data.get("loop", False))
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"message": "Loop status updated successfully.", "loop_enabled": loop_enabled}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Invalid request: {e}"}).encode('utf-8'))
            return

        if self.path == '/api/reset-data':
            with task_lock:
                if is_running:
                    self.send_response(409)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Cannot reset data while benchmark is running."}).encode('utf-8'))
                    return
                
                # Delete files
                files_to_delete = [
                    os.path.join("public", "history.db"),
                    os.path.join("public", "data", "banned_models.txt"),
                    os.path.join("public", "data", "current_key_idx.txt"),
                    os.path.join("scripts", "results.json")
                ]
                deleted = []
                errors = []
                for f in files_to_delete:
                    if os.path.exists(f):
                        try:
                            os.remove(f)
                            deleted.append(f)
                        except Exception as e:
                            errors.append(f"{f}: {e}")
                
                log_buffer.clear()
                log_buffer.append("[System] All historical and temporary benchmark data has been reset.\n")
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "message": "Data reset successfully.",
                "deleted": deleted,
                "errors": errors
            }).encode('utf-8'))
            return

        if self.path == '/api/stop-benchmark':
            with task_lock:
                loop_enabled = False
                running = is_running
                proc = active_process
            
            if not running or not proc:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "No benchmark is currently running."}).encode('utf-8'))
                return
            
            try:
                proc.terminate()
                append_log("\n[System] Stop signal sent by user. Terminating benchmark...\n")
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Failed to stop process: {e}"}).encode('utf-8'))
                return
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"message": "Stop signal sent successfully."}).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

def run_benchmark_subprocess():
    global is_running, log_buffer, last_exit_code, start_time, active_process
    
    while True:
        append_log("[System] Launching NVIDIA NIM Model Benchmarks...\n")
        try:
            # Use sys.executable to ensure we run with the same python interpreter
            # Execute test_models.py inside the scripts directory
            process = subprocess.Popen(
                [sys.executable, "-u", "scripts/test_models.py"],
                cwd=os.path.dirname(os.path.abspath(__file__)),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                encoding='utf-8'
            )
            with task_lock:
                active_process = process
            
            # Read logs in real-time
            while True:
                line = process.stdout.readline()
                if not line:
                    break
                append_log(line)
                
            process.wait()
            
            with task_lock:
                last_exit_code = process.returncode
                
            append_log(f"\n[System] Benchmark completed with exit code: {last_exit_code}\n")
        except Exception as e:
            with task_lock:
                last_exit_code = -1
            append_log(f"\n[System Error] Failed to execute benchmark script: {e}\n")
        finally:
            with task_lock:
                active_process = None
        
        # Mark running status as False so dashboard can detect run completion
        with task_lock:
            is_running = False
            
        # Wait 5 seconds to let dashboard poll and refresh before next run starts
        for _ in range(50):
            time.sleep(0.1)
            with task_lock:
                if not loop_enabled:
                    return
        
        # If loop is still enabled, start next iteration
        with task_lock:
            if not loop_enabled:
                return
            is_running = True
            log_buffer.clear()
            last_exit_code = None
            start_time = time.time()

def append_log(text):
    with task_lock:
        # Limit log size to prevent unbounded memory usage (keep last 5000 lines)
        if len(log_buffer) > 5000:
            log_buffer.pop(0)
        log_buffer.append(text)

def main():
    port = 8000
    server_address = ('', port)
    
    # Configure simple http server to work with UTF-8 encodings in Python
    SimpleHTTPRequestHandler.extensions_map.update({
        '.db': 'application/octet-stream',
        '.js': 'application/javascript',
        '.css': 'text/css',
    })
    
    httpd = HTTPServer(server_address, lambda *args, **kwargs: DashboardRequestHandler(*args, directory="public", **kwargs))
    print(f"[*] NIM Arena Local API & Web Server running on http://localhost:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping web server...")
        httpd.server_close()

if __name__ == '__main__':
    main()
