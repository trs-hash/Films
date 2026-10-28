"""Наскрізно: lectures.py run --dry проти підставних YouTube API й Ollama (без моделей і мережі).

Лекції про звички (×3), стоїків (×3) і одна окрема → дві теми, одна «без теми»; lectures.json — у формі для сайту;
повторний запуск не перепитує модель про вже оброблені лекції. Розшифровки — готові (кеш), як після Whisper.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LECS = [("habit1aaaaa", "Чому ми відкладаємо", "2026-10-27"), ("habit2aaaaa", "Як працює звичка", "2026-10-29"),
        ("stoic1aaaaa", "Стоїки про тривогу", "2026-10-31"), ("habit3aaaaa", "Дофамін і нудьга", "2026-11-03"),
        ("stoic2aaaaa", "Марк Аврелій", "2026-11-04"), ("stoic3aaaaa", "Епіктет і свобода", "2026-11-05"), ("lonely1aaaa", "Про космос", "2026-11-06")]
CALLS = {"chat": 0, "embed": 0}


def vec(text):
    """Відбиток за ключовими словами: звички / стоїки / космос — три різні напрями."""
    t = text.lower()
    v = [0.05] * 8
    if "звич" in t or "відклада" in t or "дофамін" in t: v[0] = 1
    if "стоїк" in t or "аврелій" in t or "епіктет" in t: v[3] = 1
    if "космос" in t: v[6] = 1
    return v


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if "/playlistItems" in self.path:
            if "playlistId=SH" in self.path: return self.send({"items": []})
            return self.send({"items": [{"snippet": {"title": t, "description": "", "resourceId": {"videoId": i}}, "contentDetails": {"videoId": i, "videoPublishedAt": d + "T12:00:00Z"}, "status": {"privacyStatus": "public"}} for i, t, d in LECS]})
        if "/videos" in self.path:
            ids = re.search(r"id=([^&]+)", self.path).group(1).replace("%2C", ",").split(",")
            return self.send({"items": [{"id": i, "contentDetails": {"duration": "PT40M"}} for i in ids]})
        if "/api/tags" in self.path: return self.send({"models": [{"name": "fake:latest"}, {"name": "bge-m3:latest"}]})
        self.send({}, 404)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/embed":
            CALLS["embed"] += 1
            return self.send({"embeddings": [vec(body["input"])]})
        CALLS["chat"] += 1
        p = body["messages"][0]["content"]
        if "Нотатки по частинах" in p:
            title = re.search(r"Лекція «(.+?)»", p).group(1)
            return self.send({"message": {"content": json.dumps({"summary": "Про " + title.lower(), "concepts": [title], "field": "психологія"}, ensure_ascii=False)}})
        if "ШИРОКУ тему" in p:
            lect = p.split("Дай одну")[0].lower()     # лише список лекцій, без прикладів у підказці
            name = "Звички й воля" if "відклада" in lect or "звич" in lect else "Стоїцизм"
            return self.send({"message": {"content": json.dumps({"title": name, "about": "Тема про " + name.lower()}, ensure_ascii=False)}})
        if "Чи природно" in p:
            return self.send({"message": {"content": '{"fits": false}'}})
        return self.send({"message": {"content": "Нотатка частини."}})


class E2E(unittest.TestCase):
    def test_run_dry(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        tmp = tempfile.mkdtemp()
        before = open(os.path.join(HERE, "report.md"), encoding="utf-8").read()
        try:
            repo, state = os.path.join(tmp, "repo"), os.path.join(tmp, "state")
            os.makedirs(os.path.join(state, "transcripts"))
            os.makedirs(repo)
            json.dump({"lectures": {"playlist": "UU1", "start": "2026-10-26", "exclude": ["SH"]}}, open(os.path.join(repo, "seasons.json"), "w"))
            for i, t, d in LECS:
                open(os.path.join(state, "transcripts", i + ".txt"), "w").write(("Лекція " + t + ". ") * 300)
            cfgp = os.path.join(tmp, "config.json")
            json.dump({"repo_dir": repo, "state_dir": state, "youtube_api_key": "k", "youtube_api": base, "ollama_url": base,
                       "llm_model": "fake", "embed_model": "bge-m3", "use_youtube_subs": False, "chunk_words": 500}, open(cfgp, "w"))
            env = dict(os.environ, LECTURES_CONFIG=cfgp, PYTHONIOENCODING="utf-8")
            r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "lectures.py"), "run", "--dry"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            out = json.load(open(os.path.join(repo, "lectures.json")))
            titles = sorted(t["title"] for t in out["topics"])
            self.assertEqual(titles, ["Звички й воля", "Стоїцизм"])
            habits = next(t for t in out["topics"] if t["title"] == "Звички й воля")
            self.assertEqual(habits["videos"], ["habit1aaaaa", "habit2aaaaa", "habit3aaaaa"])
            self.assertNotIn("topic", out["videos"]["lonely1aaaa"])           # одна про космос — без теми
            self.assertEqual(out["videos"]["habit1aaaaa"]["dur"], 2400)
            self.assertTrue(out["videos"]["habit1aaaaa"]["summary"].startswith("Про "))
            self.assertIn("Звички й воля", open(os.path.join(repo, "tools", "lectures", "report.md"), encoding="utf-8").read())   # звіт — у repo_dir
            self.assertEqual(open(os.path.join(HERE, "report.md"), encoding="utf-8").read(), before)                          # справжній не чіпаємо
            first = dict(CALLS)
            r2 = subprocess.run([sys.executable, "-I", os.path.join(HERE, "lectures.py"), "run", "--dry"], env=env, capture_output=True, text=True)
            self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
            self.assertEqual(CALLS["embed"], first["embed"])                  # кеш: вдруге моделі не питаємо
            self.assertEqual(json.load(open(os.path.join(repo, "lectures.json")))["topics"], out["topics"])   # стабільно
        finally:
            srv.shutdown()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
