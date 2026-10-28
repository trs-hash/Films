#!/usr/bin/env python3
"""Лекції → теми для сайту. Працює на сервері власника з локальними моделями; результат — lectures.json у репо.

  python3 tools/lectures/lectures.py run        # нові лекції: розшифрувати, зрозуміти, розкласти по темах, опублікувати
  python3 tools/lectures/lectures.py run --dry   # те саме, але без git push (подивитися, що вийде)
  python3 tools/lectures/lectures.py report     # схожість лекцій і тем — щоб підкрутити пороги (пише report.md)
  python3 tools/lectures/lectures.py check      # чи все встановлено: Ollama, моделі, yt-dlp, Whisper, git
  python3 tools/lectures/lectures.py transcribe ФАЙЛ   # розпізнати файл тим Whisper, що в config.json (перевірка й швидкість)

Кроки для кожної нової лекції (кеш — у state_dir, повторно не робимо):
  1. розшифровка: власний файл лекції з inbox_dir (ID.mp4/.m4a/.wav…) → субтитри YouTube (yt-dlp) → звук з YouTube
     і Whisper — той, що вже є на сервері (whisper_backend: faster-whisper, openai-whisper, команда на кшталт
     whisper.cpp або Whisper-служба по HTTP). Мова — українська;
  2. зміст: локальна модель (Ollama) читає розшифровку частинами й пише короткий зміст, ключові поняття, галузь;
  3. відбиток (embedding) змісту — модель bge-m3 (Ollama);
  4. теми — topics.py (широкі теми, ≥ 3 лекції на тему, злиття схожих, правки власника з overrides.json);
  5. lectures.json (його читає сайт) + report.md → git commit/push, лише коли щось змінилось.

Налаштування — config.json поруч (зразок — config.example.json). Лише стандартна бібліотека Python;
Whisper і yt-dlp потрібні тільки для розшифровки.
"""
import argparse
import datetime as dt
import glob
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import topics as T  # noqa: E402

AUDIO_EXT = (".mp4", ".mov", ".mkv", ".m4a", ".mp3", ".wav", ".aac", ".flac", ".webm", ".ogg")


# ── дрібниці, які тестує test_topics.py ──
def vtt_to_text(vtt):
    """Субтитри YouTube (WebVTT) → суцільний текст. Автосубтитри «котяться»: той самий рядок у кількох блоках."""
    out = []
    for line in vtt.splitlines():
        line = line.strip()
        if not line or line == "WEBVTT" or "-->" in line or re.match(r"^(Kind|Language|NOTE|STYLE)\b", line) or line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line).replace("&nbsp;", " ").strip()
        if line and (not out or out[-1] != line):
            out.append(line)
    words = []
    for line in out:                                   # «Привіт друзі» + «Привіт друзі сьогодні…» — без повтору
        lw = line.split()
        k = min(len(words), len(lw))
        while k and words[-k:] != lw[:k]:
            k -= 1
        words += lw[k:]
    return " ".join(words)


def chunks(text, size=1800):
    w = text.split()
    return [" ".join(w[i:i + size]) for i in range(0, len(w), size)] or [""]


def iso_dur(s):
    m = re.match(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$", str(s or ""))
    return (int(m[1] or 0) * 86400 + int(m[2] or 0) * 3600 + int(m[3] or 0) * 60 + int(m[4] or 0)) if m else 0


def json_from(text):
    """Модель іноді обгортає JSON словами чи ```json — дістаємо перший обʼєкт."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except ValueError:
        return {}


def log(*a):
    print(dt.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ── налаштування ──
def load_config():
    path = os.environ.get("LECTURES_CONFIG") or os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        sys.exit(f"Нема {path} — скопіюй config.example.json у config.json і заповни (див. tools/lectures/README.md)")
    cfg = json.load(open(path, encoding="utf-8"))
    for k, v in list(cfg.items()):
        if isinstance(v, str) and v.startswith("ENV:"):
            cfg[k] = os.environ.get(v[4:], "")
    cfg.setdefault("repo_dir", os.path.abspath(os.path.join(HERE, "..", "..")))
    cfg.setdefault("state_dir", os.path.join(os.path.expanduser("~"), ".films-lectures"))
    cfg.setdefault("ollama_url", "http://127.0.0.1:11434")
    cfg.setdefault("youtube_api", "https://www.googleapis.com/youtube/v3")
    os.makedirs(cfg["state_dir"], exist_ok=True)
    return cfg


def sh(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(cmd[:3])}…: {r.stderr.strip()[-400:]}")
    return r


# ── HTTP ──
def http_json(url, body=None, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── YouTube: список лекцій (той самий плейлист і дата, що в seasons.json → lectures) ──
def lecture_source(cfg):
    raw = open(os.path.join(cfg["repo_dir"], "seasons.json"), encoding="utf-8").read()
    try:
        s = json.loads(raw)
    except ValueError:
        s = json.loads(re.sub(r",(\s*[}\]])", r"\1", raw))
    lec = s.get("lectures") or {}
    pl = str(lec.get("playlist") or "").strip()
    m = re.search(r"(?:^|/channel/)(UC[\w-]{22})", pl)
    if m:
        pl = "UU" + m.group(1)[2:]
    ex = lec.get("exclude") or []
    return pl, str(lec.get("start") or ""), [ex] if isinstance(ex, str) else ex


def yt_items(cfg, pid):
    key, out, tok = cfg["youtube_api_key"], [], ""
    while True:
        q = urllib.parse.urlencode({"part": "snippet,contentDetails,status", "playlistId": pid, "maxResults": 50, "key": key,
                                    **({"pageToken": tok} if tok else {})})
        try:
            d = http_json(cfg["youtube_api"] + "/playlistItems?" + q, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []                              # на каналі ще нема публічних відео
            raise
        out += d.get("items", [])
        tok = d.get("nextPageToken")
        if not tok:
            return out


def list_lectures(cfg):
    pid, start, exclude = lecture_source(cfg)
    if not pid:
        sys.exit("seasons.json → lectures: нема playlist")
    skip = {i["contentDetails"]["videoId"] for p in exclude for i in yt_items(cfg, p)}
    vids = {}
    for i in yt_items(cfg, pid):
        cd, sn = i.get("contentDetails", {}), i.get("snippet", {})
        vid, pub = cd.get("videoId"), cd.get("videoPublishedAt")
        if not vid or not pub or vid in skip or (i.get("status") or {}).get("privacyStatus") == "private":
            continue
        date = dt.datetime.fromisoformat(pub.replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=kyiv_offset(pub)))).date().isoformat()
        if start and date < start:
            continue
        vids[vid] = {"id": vid, "title": sn.get("title", ""), "desc": sn.get("description", ""), "date": date}
    if vids:                                           # тривалість — videos.list, по 50
        ids = list(vids)
        for k in range(0, len(ids), 50):
            q = urllib.parse.urlencode({"part": "contentDetails", "id": ",".join(ids[k:k + 50]), "key": cfg["youtube_api_key"]})
            for v in http_json(cfg["youtube_api"] + "/videos?" + q, timeout=30).get("items", []):
                vids[v["id"]]["dur"] = iso_dur(v.get("contentDetails", {}).get("duration"))
    return vids


def kyiv_offset(iso):
    """Київ: +3 влітку (остання неділя березня — остання неділя жовтня), +2 взимку."""
    t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    def last_sunday(y, m):
        d = dt.datetime(y, m + 1, 1, tzinfo=dt.timezone.utc) - dt.timedelta(days=1)
        return d - dt.timedelta(days=(d.weekday() + 1) % 7)
    a, b = last_sunday(t.year, 3).replace(hour=1), last_sunday(t.year, 10).replace(hour=1)
    return 3 if a <= t < b else 2


# ── 1. Розшифровка ──
def transcript(cfg, v):
    path = os.path.join(cfg["state_dir"], "transcripts", v["id"] + ".txt")
    if os.path.exists(path):
        return open(path, encoding="utf-8").read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text, how = "", ""
    inbox = cfg.get("inbox_dir")
    own = [f for f in glob.glob(os.path.join(inbox, v["id"] + ".*")) if f.lower().endswith(AUDIO_EXT)] if inbox else []
    if own:
        text, how = whisper(cfg, own[0]), "власний файл + Whisper"
    if not text and cfg.get("use_youtube_subs", True):
        text, how = youtube_subs(cfg, v["id"]), "субтитри YouTube"
    if not text:
        audio = youtube_audio(cfg, v["id"])
        if audio:
            text, how = whisper(cfg, audio), "звук з YouTube + Whisper"
            os.remove(audio)
    if not text:
        raise RuntimeError("не вдалось розшифрувати: нема файлу в inbox, субтитрів і звуку (див. README → «YouTube не дає»)")
    open(path, "w", encoding="utf-8").write(text)
    log(f"{v['id']}: розшифровано ({how}), {len(text.split())} слів")
    return text


def ytdlp_base(cfg):
    cmd = [cfg.get("yt_dlp", "yt-dlp"), "--no-warnings", "--quiet"]
    if cfg.get("yt_dlp_cookies"):
        cmd += ["--cookies", cfg["yt_dlp_cookies"]]
    return cmd


def youtube_subs(cfg, vid):
    out = os.path.join(cfg["state_dir"], "subs")
    os.makedirs(out, exist_ok=True)
    r = sh(ytdlp_base(cfg) + ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "uk.*,uk", "--sub-format", "vtt",
                              "-o", os.path.join(out, "%(id)s.%(ext)s"), "https://www.youtube.com/watch?v=" + vid], check=False)
    files = sorted(glob.glob(os.path.join(out, vid + "*.vtt")), key=lambda f: ("orig" in f, f))   # ручні першими
    text = vtt_to_text(open(files[0], encoding="utf-8").read()) if files else ""
    if not text and r.returncode:
        log(f"{vid}: субтитрів нема ({r.stderr.strip()[-200:]})")
    return text


def youtube_audio(cfg, vid):
    out = os.path.join(cfg["state_dir"], "audio")
    os.makedirs(out, exist_ok=True)
    r = sh(ytdlp_base(cfg) + ["-f", "bestaudio", "-x", "--audio-format", "m4a", "-o", os.path.join(out, "%(id)s.%(ext)s"),
                              "https://www.youtube.com/watch?v=" + vid], check=False)
    files = glob.glob(os.path.join(out, vid + ".*"))
    if not files:
        log(f"{vid}: звук не завантажено ({r.stderr.strip()[-300:]})")
    return files[0] if files else ""


# Whisper — той, що вже стоїть на сервері (whisper_backend у config.json):
#   faster-whisper / openai-whisper — бібліотека Python (у тому середовищі, яким запускають lectures.py);
#   command — будь-яка команда (whisper.cpp, CLI openai-whisper, whisper-ctranslate2…), whisper_command;
#   http — Whisper-служба: OpenAI-сумісна (…/v1/audio/transcriptions), whisper.cpp server (…/inference)
#          чи whisper-asr-webservice (…/asr?output=txt, поле файлу audio_file), whisper_url;
#   auto (типово) — whisper_url → http, whisper_command → command, інакше бібліотека, яку знайдемо.
def _has(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def whisper_backend(cfg):
    b = str(cfg.get("whisper_backend") or "auto").strip().lower()
    if b != "auto":
        return b
    if cfg.get("whisper_url"):
        return "http"
    if cfg.get("whisper_command"):
        return "command"
    if _has("faster_whisper"):
        return "faster-whisper"
    if _has("whisper"):                                # не плутати з whisper від Graphite (база даних): там нема load_model
        try:
            if hasattr(importlib.import_module("whisper"), "load_model"):
                return "openai-whisper"
        except Exception:
            pass
    return "none"


def whisper(cfg, path):
    """Розпізнати звук (мова — cfg.language) тим Whisper, що є на сервері. Повертає текст одним рядком."""
    b = whisper_backend(cfg)
    if b == "http":
        return whisper_http(cfg, path)
    if b == "command":
        return whisper_command(cfg, path)
    if b in ("faster-whisper", "openai-whisper"):
        return whisper_lib(cfg, path, b)
    raise RuntimeError(f"Whisper не знайдено (whisper_backend: {b}) — config.json: whisper_backend / whisper_command / whisper_url "
                       "(див. tools/lectures/README.md)")


_WHISPER = None
def whisper_lib(cfg, path, b):
    global _WHISPER
    lang, name, dev = cfg.get("language", "uk"), cfg.get("whisper_model") or "medium", cfg.get("whisper_device", "auto")
    root = cfg.get("whisper_download_root") or None    # де вже лежать моделі (щоб не качати вдруге)
    if b == "faster-whisper":
        from faster_whisper import WhisperModel       # лише коли справді треба розпізнавати
        if _WHISPER is None:
            ct = cfg.get("whisper_compute_type") or ("float16" if dev == "cuda" else "int8")
            _WHISPER = WhisperModel(name, device=dev, compute_type=ct, download_root=root)
        segs, _ = _WHISPER.transcribe(path, language=lang, vad_filter=True, beam_size=5)
        return " ".join(s.text.strip() for s in segs).strip()
    import whisper as openai_whisper                   # openai-whisper
    if _WHISPER is None:
        _WHISPER = openai_whisper.load_model(name, device=None if dev == "auto" else dev, download_root=root)
    return " ".join(str(_WHISPER.transcribe(path, language=lang).get("text", "")).split())


def whisper_command(cfg, path):
    """whisper_command — список або рядок (без оболонки). Підстановки: {audio} — файл; {wav} — він же у WAV 16 кГц моно
    (ffmpeg; whisper.cpp хоче саме такий); {outdir} — тимчасова тека; {out} — {outdir}/transcript; {lang}; {model}.
    Текст — з .txt (потім .srt, .vtt) у {outdir}, а якщо файлів нема — зі стандартного виводу."""
    tpl = cfg["whisper_command"]
    tpl = shlex.split(tpl) if isinstance(tpl, str) else [str(x) for x in tpl]
    with tempfile.TemporaryDirectory(prefix="films-whisper-") as tmp:
        vals = {"audio": path, "outdir": tmp, "out": os.path.join(tmp, "transcript"), "lang": cfg.get("language", "uk"),
                "model": str(cfg.get("whisper_model") or ""), "wav": ""}
        if any("{wav}" in t for t in tpl):
            vals["wav"] = os.path.join(tmp, "audio.wav")
            sh(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", vals["wav"]])
        cmd = [re.sub(r"\{(\w+)\}", lambda m: vals.get(m.group(1), m.group(0)), t) for t in tpl]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=int(cfg.get("whisper_timeout", 6 * 3600)))
        if r.returncode:
            raise RuntimeError(f"whisper_command: код {r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}")
        for ext in (".txt", ".srt", ".vtt"):
            files = sorted(glob.glob(os.path.join(tmp, "*" + ext)))
            if files:
                raw = open(files[0], encoding="utf-8", errors="replace").read()
                return " ".join((raw if ext == ".txt" else vtt_to_text(raw)).split())
        out = re.sub(r"\[\d[\d:.,]* --> \d[\d:.,]*\]", " ", r.stdout)   # whisper.cpp друкує [00:00:00.000 --> 00:00:05.000]
        return " ".join(out.split())


def whisper_http(cfg, path):
    """Файл — multipart (поле whisper_file_field, типово file) + language, response_format=text, model (якщо задано)."""
    fields = {"language": cfg.get("language", "uk"), "response_format": "text"}
    if cfg.get("whisper_model"):
        fields["model"] = str(cfg["whisper_model"])
    bnd = "films" + uuid.uuid4().hex
    head = b"".join(f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items())
    head += (f'--{bnd}\r\nContent-Disposition: form-data; name="{cfg.get("whisper_file_field") or "file"}"; '
             f'filename="{os.path.basename(path)}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    with open(path, "rb") as f:
        data = head + f.read() + f"\r\n--{bnd}--\r\n".encode()
    headers = {"Content-Type": "multipart/form-data; boundary=" + bnd}
    if cfg.get("whisper_api_key"):
        headers["Authorization"] = "Bearer " + cfg["whisper_api_key"]
    req = urllib.request.Request(cfg["whisper_url"], data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=int(cfg.get("whisper_timeout", 6 * 3600))) as r:
        body = r.read().decode("utf-8", errors="replace")
    try:
        j = json.loads(body)
        if isinstance(j, dict):
            body = str(j.get("text", ""))
    except ValueError:
        pass                                           # простий текст
    return " ".join(body.split())


# ── 2–3. Розуміння: Ollama ──
def ollama_chat(cfg, prompt, want_json=True):
    body = {"model": cfg["llm_model"], "stream": False, "messages": [{"role": "user", "content": prompt}],
            "options": {"temperature": 0.2, "num_ctx": int(cfg.get("num_ctx", 8192))}}
    if want_json:
        body["format"] = "json"
    return http_json(cfg["ollama_url"].rstrip("/") + "/api/chat", body)["message"]["content"]


def ollama_embed(cfg, text):
    d = http_json(cfg["ollama_url"].rstrip("/") + "/api/embed", {"model": cfg.get("embed_model", "bge-m3"), "input": text})
    return d["embeddings"][0]


def understand(cfg, v, text):
    """Зміст великої лекції — частинами (малі моделі мають коротку памʼять), потім загальний висновок."""
    notes = []
    for i, part in enumerate(chunks(text, int(cfg.get("chunk_words", 1800)))):
        notes.append(ollama_chat(cfg, (
            f"Це частина {i + 1} розшифровки лекції «{v['title']}» українською (автоматична, з помилками).\n"
            "Коротко (3–4 речення) переслів, про що тут ідеться: головні думки й поняття. Без вступів.\n\n" + part), want_json=False).strip())
    r = json_from(ollama_chat(cfg, (
        f"Лекція «{v['title']}». Нотатки по частинах:\n- " + "\n- ".join(notes) + "\n\n"
        "Відповідай JSON українською: {\"summary\": \"про що лекція, 2–3 речення для глядача\", "
        "\"concepts\": [\"5–8 ключових понять\"], \"field\": \"широка галузь знань, 1–3 слова (напр. психологія, філософія)\"}")))
    return {"summary": str(r.get("summary", "")).strip()[:600], "concepts": [str(c) for c in (r.get("concepts") or [])][:10],
            "field": str(r.get("field", "")).strip()[:60]}


def namer_for(cfg, videos):
    def namer(members, existing, examples):
        lect = "\n".join(f"- «{videos[m]['title']}»: {videos[m].get('summary', '')}" for m in members)
        prompt = (
            "Ти впорядковуєш лекції автора за темами на його сайті. Ось лекції, які мають бути в ОДНІЙ темі:\n" + lect + "\n\n"
            "Дай одну ШИРОКУ тему, що обʼєднує їх і в яку природно ляжуть майбутні лекції на суміжні питання. "
            "1–3 слова, українською, без лапок; не повторюй назву жодної лекції; не вузько (не «Прокрастинація в понеділок», "
            "а «Звички й воля»). Ще — одне речення для глядача (до 120 символів), про що ця тема.\n"
            + (f"Уже є теми (не дублюй, але можеш бути в тому ж стилі): {', '.join(existing)}.\n" if existing else "")
            + (f"Так автор сам назвав свої теми — тримай таку ширину й стиль: {', '.join(examples)}.\n" if examples else "")
            + "Відповідай JSON: {\"title\": \"…\", \"about\": \"…\"}")
        return json_from(ollama_chat(cfg, prompt))
    return namer


def judge_for(cfg, videos):
    def judge(vid, topic):
        v = videos[vid]
        others = "; ".join(videos[m]["title"] for m in topic["members"][:6] if m in videos)
        r = json_from(ollama_chat(cfg, (
            f"Тема на сайті: «{topic['title']}» — {topic.get('about', '')}. У ній лекції: {others}.\n"
            f"Нова лекція «{v['title']}»: {v.get('summary', '')}\n"
            "Чи природно покласти нову лекцію в цю тему (тема широка, точний збіг не потрібен)? "
            "Відповідай JSON: {\"fits\": true|false}")))
        return bool(r.get("fits"))
    return judge


# ── 4–5. Теми, файли, git ──
def git_publish(cfg, message, files):
    repo = cfg["repo_dir"]
    sh(["git", "add", "--"] + files, cwd=repo)
    if sh(["git", "diff", "--cached", "--quiet"], cwd=repo, check=False).returncode == 0:
        log("без змін у файлах сайту")
        return
    sh(["git", "-c", "user.name=lectures-bot", "-c", "user.email=lectures-bot@users.noreply.github.com", "commit", "-m", message], cwd=repo)
    for i in range(4):                                 # архів на GitHub теж комітить щогодини — підтягуємо й повторюємо
        sh(["git", "pull", "--rebase", "--quiet"], cwd=repo, check=False)
        if sh(["git", "push", "--quiet"], cwd=repo, check=False).returncode == 0:
            log("опубліковано: " + message)
            return
        time.sleep(5 * (i + 1))
    raise RuntimeError("git push не вдався 4 рази — перевір доступ (deploy key) і мережу")


def run(cfg, dry=False):
    repo, state_dir = cfg["repo_dir"], cfg["state_dir"]
    if not dry:
        sh(["git", "pull", "--rebase", "--quiet"], cwd=repo, check=False)
    vids = list_lectures(cfg)
    log(f"лекцій на YouTube: {len(vids)}")
    cache_dir = os.path.join(state_dir, "videos")
    os.makedirs(cache_dir, exist_ok=True)
    videos, emb, failed = {}, {}, []
    for vid, v in sorted(vids.items(), key=lambda kv: kv[1]["date"]):
        cpath = os.path.join(cache_dir, vid + ".json")
        c = json.load(open(cpath, encoding="utf-8")) if os.path.exists(cpath) else None
        if c is None:
            try:
                text = transcript(cfg, v)
                u = understand(cfg, v, text)
                e = ollama_embed(cfg, f"{v['title']}. {u['summary']} Поняття: {', '.join(u['concepts'])}. Галузь: {u['field']}")
                c = dict(v, **u, embedding=e)
                json.dump(c, open(cpath, "w", encoding="utf-8"), ensure_ascii=False)
                log(f"{vid}: «{v['title']}» → {u['field']}; {', '.join(u['concepts'][:4])}")
            except Exception as ex:                    # одна лекція не має зупиняти решту
                failed.append(vid)
                log(f"{vid}: ПОМИЛКА — {ex}")
                continue
        c.update({k: v[k] for k in ("title", "date", "dur") if k in v})   # назва/тривалість могли змінитись
        videos[vid], emb[vid] = c, c["embedding"]
    tpath = os.path.join(state_dir, "topics.json")
    state = json.load(open(tpath, encoding="utf-8")) if os.path.exists(tpath) else {}
    own = os.path.join(repo, "tools", "lectures")       # правки власника й звіт — у репозиторії сайту (repo_dir)
    opath = os.path.join(own, "overrides.json")
    overrides = json.load(open(opath, encoding="utf-8")) if os.path.exists(opath) else {}
    tp = T.Topics(state, emb, cfg.get("topics"), namer=namer_for(cfg, videos), judge=judge_for(cfg, videos), log=log)
    state = tp.run(sorted(videos, key=lambda k: videos[k]["date"]), overrides)
    json.dump(state, open(tpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    model = {"llm": cfg["llm_model"], "embed": cfg.get("embed_model", "bge-m3"), "whisper": cfg.get("whisper_model", "medium")}
    out = T.site_json(state, videos, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), model)
    site = os.path.join(repo, "lectures.json")
    old = json.load(open(site, encoding="utf-8")) if os.path.exists(site) else {}
    strip = lambda d: {k: v for k, v in d.items() if k != "generated"}
    files = []
    if strip(old) != strip(out):
        json.dump(out, open(site, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        files.append("lectures.json")
    rep = report(videos, emb, state, failed)
    rpath = os.path.join(own, "report.md")
    if not os.path.exists(rpath) or open(rpath, encoding="utf-8").read() != rep:
        os.makedirs(own, exist_ok=True)
        open(rpath, "w", encoding="utf-8").write(rep)
        files.append("tools/lectures/report.md")
    log(f"тем: {len(out['topics'])}; без теми: {sum(1 for v in out['videos'].values() if 'topic' not in v)}; помилок: {len(failed)}")
    if files and not dry:
        git_publish(cfg, f"лекції: теми оновлено ({len(out['topics'])} тем, {len(videos)} лекцій)", files)
    return 1 if failed else 0


def report(videos, emb, state, failed):
    """Для налаштування «тут»: де кожна лекція, наскільки схожа на свою й найближчу іншу тему."""
    lines = ["# Теми лекцій — звіт останнього запуску", "",
             "Схожість: 1 — те саме, ~0.6 і вище — одна тема, нижче ~0.5 — різне. Пороги — config.json → topics.", ""]
    centers = {t["id"]: T.centroid([emb[m] for m in t["members"] if m in emb]) for t in state["topics"]}
    for t in state["topics"]:
        lines.append(f"## {t['title']} (`{t['id']}`){' 🔒' if t.get('locked') else ''} — {len(t['members'])}")
        if t.get("about"):
            lines.append(f"_{t['about']}_")
        for m in t["members"]:
            if m in videos:
                lines.append(f"- {videos[m]['date']} «{videos[m]['title']}» — {T.cos(emb[m], centers[t['id']]):.2f}")
        lines.append("")
    free = [v for v in videos if not any(v in t["members"] for t in state["topics"])]
    if free:
        lines.append("## Без теми (на сайті — «Нові студії»)")
        for v in free:
            near = sorted(((T.cos(emb[v], c), tid) for tid, c in centers.items() if c), reverse=True)[:2]
            lines.append(f"- {videos[v]['date']} «{videos[v]['title']}» — найближче: " + (", ".join(f"`{tid}` {s:.2f}" for s, tid in near) or "тем ще нема"))
        lines.append("")
    if failed:
        lines += ["## Не вдалось обробити", *[f"- {v}" for v in failed], ""]
    return "\n".join(lines)


def check(cfg):
    ok = True
    def row(name, good, hint=""):
        nonlocal ok
        ok &= bool(good)
        print(("✅ " if good else "❌ ") + name + ("" if good else f" — {hint}"))
    try:
        tags = [m["name"] for m in http_json(cfg["ollama_url"].rstrip("/") + "/api/tags", timeout=10).get("models", [])]
        row("Ollama працює", True)
        for m in (cfg["llm_model"], cfg.get("embed_model", "bge-m3")):
            row(f"модель {m}", any(t in (m, m + ":latest") for t in tags), f"ollama pull {m}")
    except Exception as e:
        row("Ollama працює", False, f"{e} (systemctl status ollama)")
    def runs(cmd):                                     # програми може не бути зовсім — це ❌, а не падіння
        try:
            return sh(cmd, check=False).returncode == 0
        except OSError:
            return False
    row("yt-dlp", runs([cfg.get("yt_dlp", "yt-dlp"), "--version"]), "pip install -U yt-dlp")
    b = whisper_backend(cfg)
    if b == "http":
        try:
            urllib.request.urlopen(cfg["whisper_url"], timeout=10)
            good = True
        except urllib.error.HTTPError:
            good = True                                # відповіла (хай і 404/405 на GET) — служба жива
        except Exception:
            good = False
        row(f"Whisper-служба {cfg['whisper_url']}", good, "служба не відповідає (systemctl / docker ps)")
    elif b == "command":
        tpl = cfg["whisper_command"]
        exe = (shlex.split(tpl) if isinstance(tpl, str) else [str(x) for x in tpl] or [""])[0]
        row(f"Whisper-команда {exe}", bool(shutil.which(exe)), "нема такої програми або її не видно користувачу служби")
    elif b in ("faster-whisper", "openai-whisper"):
        row(f"Whisper: {b} (модель {cfg.get('whisper_model') or 'medium'})", _has("faster_whisper" if b == "faster-whisper" else "whisper"),
            f"цей Python ({sys.executable}) не бачить {b}")
    else:
        row("Whisper", False, "не знайдено — whisper_backend / whisper_command / whisper_url у config.json або pip install faster-whisper")
    row("ffmpeg", runs(["ffmpeg", "-version"]), "apt install ffmpeg")
    row("ключ YouTube API", bool(cfg.get("youtube_api_key")), "config.json → youtube_api_key")
    row("git push (сухий)", sh(["git", "push", "--dry-run", "--quiet"], cwd=cfg["repo_dir"], check=False).returncode == 0, "deploy key з правом запису")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["run", "report", "check", "transcribe"])
    ap.add_argument("file", nargs="?", help="для transcribe: аудіо- чи відеофайл")
    ap.add_argument("--dry", action="store_true", help="без git push")
    a = ap.parse_args()
    cfg = load_config()
    if a.cmd == "check":
        sys.exit(check(cfg))
    if a.cmd == "transcribe":                          # перевірити Whisper на своєму файлі: що розпізнав і як швидко
        if not a.file or not os.path.exists(a.file):
            sys.exit("transcribe ФАЙЛ — потрібен наявний файл")
        t0 = time.time()
        text = whisper(cfg, a.file)
        print(f"Whisper: {whisper_backend(cfg)}; {time.time() - t0:.1f} с; {len(text.split())} слів\n{text[:1500]}")
        sys.exit(0 if text else 1)
    if a.cmd == "report":
        a.dry = True
    sys.exit(run(cfg, dry=a.dry))


if __name__ == "__main__":
    main()
