"""End-to-end smoke test for the local OpenAI-compatible adapter."""

import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import server


class FakeRunner(BaseHTTPRequestHandler):
    requests = []
    reject_tools = False
    redirect_models = False

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != "/v1/models":
            self.send_error(404)
            return
        if self.redirect_models:
            self.send_response(302)
            self.send_header("Location", "https://example.com/v1/models")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = json.dumps({"data": [{"id": "test-model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        if self.reject_tools and body.get("tools"):
            data = b'{"error":"tool calling is not supported"}'
            self.send_response(400)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if not body["stream"]:
            data = json.dumps({"choices": [{"message": {"content": "A Test Title"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        events = [
            {"choices": [{"delta": {"content": "Hello "}}]},
            {"choices": [{"delta": {"content": "world"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {
                "name": "calculate", "arguments": '{"expression":'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {
                "arguments": '"1+1"}'}}]}, "finish_reason": "tool_calls"}]},
        ]
        data = ("".join("data: " + json.dumps(event) + "\n\n" for event in events)
                + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class BackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        server.DATA = Path(cls.temp.name)
        server.CHATS = server.DATA / "chats"
        cls.runner = ThreadingHTTPServer(("127.0.0.1", 0), FakeRunner)
        cls.lantern = server.Server(("127.0.0.1", 0), server.Handler)
        cls.threads = [threading.Thread(target=instance.serve_forever, daemon=True)
                       for instance in (cls.runner, cls.lantern)]
        for thread in cls.threads:
            thread.start()
        server.save_settings({"backend": "openai", "openai_base_url":
            "http://127.0.0.1:%d/v1" % cls.runner.server_port})
        cls.url = "http://127.0.0.1:%d" % cls.lantern.server_port

    @classmethod
    def tearDownClass(cls):
        for instance in (cls.lantern, cls.runner):
            instance.shutdown()
            instance.server_close()
        cls.temp.cleanup()

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data,
            headers={"Content-Type": "application/json"} if data else {})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read().decode()

    def test_models_title_and_stream(self):
        models = json.loads(self.request("/api/models"))
        self.assertEqual(models["models"][0]["name"], "test-model")
        title = json.loads(self.request("/api/title", {"model": "test-model", "transcript": "Hi"}))
        self.assertEqual(title["title"], "A Test Title")
        response = self.request("/api/chat", {"model": "test-model", "messages": [
            {"role": "user", "content": "Hi"}], "options": {"num_predict": 20}})
        chunks = [json.loads(line) for line in response.splitlines()]
        self.assertEqual("".join(c.get("message", {}).get("content", "") for c in chunks), "Hello world")
        self.assertEqual(chunks[-1]["message"]["tool_calls"][0]["function"]["arguments"],
                         {"expression": "1+1"})
        self.assertTrue(chunks[-1]["done"])
        self.assertEqual(FakeRunner.requests[-1]["max_tokens"], 20)

        self.request("/api/chat", {"model": "test-model", "messages": [
            {"role": "user", "content": "Calculate"},
            {"role": "assistant", "content": "", "tool_calls": [{"function": {
                "name": "calculate", "arguments": {"expression": "1+1"}}}]},
            {"role": "tool", "tool_name": "calculate", "content": "2"}],
            "tools": ["calculate"]})
        sent = FakeRunner.requests[-1]
        self.assertEqual(sent["messages"][-1]["tool_call_id"],
                         sent["messages"][-2]["tool_calls"][0]["id"])
        self.assertEqual(sent["tools"][0]["function"]["name"], "calculate")

    def test_remote_endpoint_is_rejected(self):
        saved = server.get_settings()["openai_base_url"]
        for url in ("https://example.com/v1", "http://localhost.evil:1234/v1",
                    "http://127.0.0.1:1234/v1?redirect=https://example.com"):
            server.save_settings({"openai_base_url": url})
            self.assertEqual(server.get_settings()["openai_base_url"], saved)

    def test_remote_redirect_is_rejected(self):
        FakeRunner.redirect_models = True
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                server.list_models()
            self.assertEqual(caught.exception.code, 302)
            caught.exception.close()
        finally:
            FakeRunner.redirect_models = False

    def test_tool_rejection_retries_plain_chat(self):
        FakeRunner.reject_tools = True
        try:
            response = self.request("/api/chat", {"model": "test-model",
                "messages": [{"role": "user", "content": "Hi"}], "tools": ["calculate"]})
            chunks = [json.loads(line) for line in response.splitlines()]
            self.assertIn("rejected tools", chunks[0]["warning"])
            self.assertTrue(chunks[0]["tools_unavailable"])
            self.assertTrue(chunks[-1]["done"])
            self.assertNotIn("tools", FakeRunner.requests[-1])
            models = json.loads(self.request("/api/models"))
            self.assertFalse(models["models"][0]["supports_tools"])
        finally:
            FakeRunner.reject_tools = False
            server._openai_no_tools.clear()


if __name__ == "__main__":
    unittest.main()
