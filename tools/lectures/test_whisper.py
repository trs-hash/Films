"""Наявний на сервері Whisper: команда (whisper.cpp, CLI openai-whisper…) і служба по HTTP — з підставними замість справжніх.
python3 -m unittest tools/lectures/test_whisper.py  (і з tests/qa.js, кейс LT01)
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lectures as L  # noqa: E402


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.audio = os.path.join(self.tmp, "abc123.m4a")
        with open(self.audio, "wb") as f:
            f.write(b"\x00\x01FAKEAUDIO")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def script(self, body):
        p = os.path.join(self.tmp, "fake_whisper.py")
        with open(p, "w", encoding="utf-8") as f:
            f.write("import sys, os\n" + body)
        return p


class CommandTest(Tmp):
    def test_txt_in_out(self):
        # як whisper.cpp: -of {out} -otxt → {out}.txt; мова доходить до команди
        s = self.script("open(sys.argv[2] + '.txt', 'w', encoding='utf-8').write('Привіт\\nсвіт, мова ' + sys.argv[3] + '\\n')")
        cfg = {"whisper_backend": "command", "whisper_command": [sys.executable, s, "{audio}", "{out}", "{lang}"], "language": "uk"}
        self.assertEqual(L.whisper(cfg, self.audio), "Привіт світ, мова uk")

    def test_string_template_and_srt_in_outdir(self):
        # як CLI openai-whisper: --output_dir {outdir} --output_format srt → <назва>.srt
        s = self.script("open(os.path.join(sys.argv[2], 'abc123.srt'), 'w', encoding='utf-8').write("
                        "'1\\n00:00:00,000 --> 00:00:02,000\\nДобрий день\\n\\n2\\n00:00:02,000 --> 00:00:04,000\\nсьогодні про звички\\n')")
        cfg = {"whisper_command": f'"{sys.executable}" "{s}" {{audio}} {{outdir}}'}          # рядок; backend — auto
        self.assertEqual(L.whisper_backend(cfg), "command")
        self.assertEqual(L.whisper(cfg, self.audio), "Добрий день сьогодні про звички")

    def test_stdout_without_timestamps(self):
        s = self.script("print('[00:00:00.000 --> 00:00:05.000]  Перше речення.'); print('[00:00:05.000 --> 00:00:09.500]  Друге.')")
        cfg = {"whisper_backend": "command", "whisper_command": [sys.executable, s, "{audio}"]}
        self.assertEqual(L.whisper(cfg, self.audio), "Перше речення. Друге.")

    def test_failure_is_reported(self):
        s = self.script("sys.stderr.write('model not found'); sys.exit(3)")
        cfg = {"whisper_backend": "command", "whisper_command": [sys.executable, s, "{audio}"]}
        with self.assertRaisesRegex(RuntimeError, "model not found"):
            L.whisper(cfg, self.audio)


class Fake(BaseHTTPRequestHandler):
    seen = []
    reply = ""

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Fake.seen.append({"path": self.path, "ctype": self.headers["Content-Type"], "auth": self.headers.get("Authorization"), "body": body})
        out = Fake.reply.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def log_message(self, *a):
        pass


class HttpTest(Tmp):
    def setUp(self):
        super().setUp()
        self.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_port}"
        Fake.seen = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def test_openai_compatible_json(self):
        Fake.reply = json.dumps({"text": " Лекція про волю.\n"}, ensure_ascii=False)
        cfg = {"whisper_url": self.base + "/v1/audio/transcriptions", "whisper_model": "Systran/faster-whisper-large-v3",
               "whisper_api_key": "k1", "language": "uk"}
        self.assertEqual(L.whisper_backend(cfg), "http")
        self.assertEqual(L.whisper(cfg, self.audio), "Лекція про волю.")
        r = Fake.seen[0]
        self.assertEqual(r["path"], "/v1/audio/transcriptions")
        self.assertIn("multipart/form-data; boundary=", r["ctype"])
        self.assertEqual(r["auth"], "Bearer k1")
        for part in (b'name="language"\r\n\r\nuk', b'name="response_format"\r\n\r\ntext', b'name="model"\r\n\r\nSystran/faster-whisper-large-v3',
                     b'name="file"; filename="abc123.m4a"', b"\x00\x01FAKEAUDIO"):
            self.assertIn(part, r["body"])

    def test_asr_webservice_plain_text(self):
        # whisper-asr-webservice: /asr?output=txt, поле файлу audio_file, відповідь — простий текст
        Fake.reply = "Стоїки про тривогу\nі спокій"
        cfg = {"whisper_backend": "http", "whisper_url": self.base + "/asr?task=transcribe&language=uk&output=txt", "whisper_file_field": "audio_file"}
        self.assertEqual(L.whisper(cfg, self.audio), "Стоїки про тривогу і спокій")
        self.assertIn(b'name="audio_file"; filename="abc123.m4a"', Fake.seen[0]["body"])
        self.assertNotIn(b'name="model"', Fake.seen[0]["body"])          # модель не задано — не надсилаємо


class AutoTest(unittest.TestCase):
    def test_auto_prefers_configured_then_libraries(self):
        orig = L._has
        try:
            L._has = lambda m: m == "faster_whisper"
            self.assertEqual(L.whisper_backend({}), "faster-whisper")
            self.assertEqual(L.whisper_backend({"whisper_backend": "AUTO", "whisper_url": "http://x"}), "http")
            L._has = lambda m: False
            self.assertEqual(L.whisper_backend({}), "none")
            with self.assertRaisesRegex(RuntimeError, "Whisper не знайдено"):
                L.whisper({}, "/nema.m4a")
        finally:
            L._has = orig


if __name__ == "__main__":
    unittest.main()
