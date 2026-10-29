"""Гавриїл → зустрічі на taras.kyiv.ua (керування подіями). Готовий шматок для бота на Python (лише стандартна бібліотека).

Бот нічого не розбирає сам: пересилає текст команди в GitHub (workflow «Зустріч із бота»), а відповідь
«✅ додано / ❌ що не так» надсилає в цей самий чат задача GitHub (секрет TG_BOT_TOKEN у репозиторії).
Реєстрації й оплати — окремо, на сервері бота (див. PROMPT-zustrichi.md): тут лише сама подія на сайті.

Команди (лише від власника — FILMS_OWNER_IDS):
    /zustrich                          поля рядками: дата: 14.11 19:00–21:00 / назва / місто / місце / адреса /
                                       ціна: 300 або безкоштовно / місць: 40 / опис / реєстрація: ні | https://… / id
    /zustrichi                         що на сайті
    /skasuvaty [id | 14.11 | назва]     скасувати; /vidnovyty — повернути; /vydalyty — прибрати зовсім
    /oplata online | onsite            платні: карткою через monobank чи на місці
    /zustrichi_nalashtuvannia          api: https://… (сервер бота), telegram: ІмʼяБота

Змінні середовища бота:
    FILMS_GITHUB_TOKEN  fine-grained токен GitHub: лише репозиторій trs-hash/Films, дозвіл Actions — Read and write
    FILMS_OWNER_IDS     твій Telegram user id (кілька — через кому); решті бот відмовляє
"""
import json
import os
import urllib.error
import urllib.request

REPO = "trs-hash/Films"
WORKFLOW = "meeting.yml"
MEET_COMMANDS = ("zustrich", "zustrichi", "skasuvaty", "vidnovyty", "vydalyty", "oplata", "zustrichi_nalashtuvannia")


def is_owner(user_id) -> bool:
    owners = {x.strip() for x in os.environ.get("FILMS_OWNER_IDS", "").split(",") if x.strip()}
    return str(user_id) in owners


def films_meeting(chat_id, text: str = "", action: str = "", data: dict | None = None) -> str:
    """Надсилає команду в GitHub. text — повний текст із /командою; або action + data (поля словником) — для
    бота-асистента. Повертає, що відповісти в чат одразу (результат прийде окремим повідомленням).
    В асинхронному боті викликай через asyncio.to_thread(...), щоб не блокувати event loop."""
    token = os.environ.get("FILMS_GITHUB_TOKEN", "")
    if not token:
        return "❌ Нема FILMS_GITHUB_TOKEN — бот не може достукатися до сайту."
    inputs = {"text": str(text)[:4000], "chat_id": str(chat_id)}
    if action:
        inputs["action"] = str(action)
    if data:
        inputs["data"] = json.dumps(data, ensure_ascii=False)[:4000]
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        data=json.dumps({"ref": "main", "inputs": inputs}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status == 204:
                return "⏳ Прийняв. За хвилину відпишу, що вийшло."
            return f"❌ GitHub відповів {r.status}. Спробуй ще раз за хвилину."
    except urllib.error.HTTPError as e:
        return {
            401: "❌ GitHub не прийняв токен (FILMS_GITHUB_TOKEN недійсний або прострочений).",
            403: "❌ Токену бракує дозволу Actions: Read and write на trs-hash/Films.",
            404: "❌ GitHub не бачить репозиторій чи workflow meeting.yml (він має бути в main).",
            422: "❌ GitHub відхилив запит: workflow meeting.yml не знайдено в main або неправильні поля.",
        }.get(e.code, f"❌ GitHub відповів {e.code}. Спробуй ще раз за хвилину.")
    except (urllib.error.URLError, TimeoutError, OSError):
        return "❌ Не достукався до GitHub (мережа чи таймаут). Спробуй ще раз."
