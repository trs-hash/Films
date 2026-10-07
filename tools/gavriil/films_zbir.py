"""Гавриїл → збори на taras.kyiv.ua. Готовий шматок для бота на Python (без залежностей, лише стандартна бібліотека).

Бот нічого не розбирає сам: пересилає текст команди в GitHub (workflow «Збір із бота»), а відповідь
«✅ додано / ❌ що не так» надсилає в цей самий чат задача GitHub (якщо в репозиторії є секрет TG_BOT_TOKEN).

Команди (лише від власника — FILMS_OWNER_IDS):
    /zbir https://send.monobank.ua/jar/…      додати або оновити збір (назва, опис, ціль — із самої банки)
    /zbir <посилання>
    Назва збору                               інша назва — другим рядком, далі опис;
    ціль 50000, до 31.12, благодійний         за бажання — ціль, останній день, вид
    /zakryty [id | посилання | частина назви]  закрити збір
    /zbory                                    що зараз на сайті

Змінні середовища бота:
    FILMS_GITHUB_TOKEN  fine-grained токен GitHub: лише репозиторій trs-hash/Films, дозвіл Actions — Read and write
    FILMS_OWNER_IDS     твій Telegram user id (кілька — через кому); решті бот відмовляє
"""
import json
import os
import urllib.error
import urllib.request

REPO = "trs-hash/Films"
WORKFLOW = "fundraiser.yml"
COMMANDS = ("zbir", "zakryty", "zbory")


def is_owner(user_id) -> bool:
    owners = {x.strip() for x in os.environ.get("FILMS_OWNER_IDS", "").split(",") if x.strip()}
    return str(user_id) in owners


def films_zbir(text: str, chat_id) -> str:
    """Надсилає команду в GitHub. Повертає, що відповісти в чат одразу (результат прийде окремим повідомленням)."""
    token = os.environ.get("FILMS_GITHUB_TOKEN", "")
    if not token:
        return "❌ Нема FILMS_GITHUB_TOKEN — бот не може достукатися до сайту."
    body = json.dumps({"ref": "main", "inputs": {"text": text[:4000], "chat_id": str(chat_id)}}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass                                            # 204 — прийнято
    except urllib.error.HTTPError as e:
        hint = {401: "токен недійсний або прострочений", 403: "токену бракує дозволу Actions: Read and write",
                404: "нема доступу до репозиторію або workflow ще не в main",
                422: "workflow не знайдено в main"}.get(e.code, e.read()[:200].decode("utf-8", "replace"))
        return f"❌ GitHub не прийняв команду ({e.code}): {hint}"
    except OSError as e:
        return f"❌ Не достукався до GitHub: {e}"
    return "⏳ Прийняв. За хвилину відпишу, що вийшло."


# ── Приклад: python-telegram-bot 20+ ────────────────────────────────────────────
#   from telegram import Update
#   from telegram.ext import CommandHandler, ContextTypes
#   from films_zbir import films_zbir, is_owner, COMMANDS
#
#   async def zbir_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
#       if not is_owner(update.effective_user.id):
#           return
#       await update.message.reply_text(films_zbir(update.message.text, update.effective_chat.id))
#
#   app.add_handler(CommandHandler(list(COMMANDS), zbir_cmd))
#
# ── Приклад: aiogram 3 ──────────────────────────────────────────────────────────
#   from aiogram.filters import Command
#   from aiogram.types import Message
#
#   @router.message(Command(*COMMANDS))
#   async def zbir_cmd(message: Message):
#       if not is_owner(message.from_user.id):
#           return
#       await message.answer(films_zbir(message.text, message.chat.id))
#
# urllib тут блокує ~1 с. У дуже навантаженому боті можна обгорнути: await asyncio.to_thread(films_zbir, text, chat_id)
