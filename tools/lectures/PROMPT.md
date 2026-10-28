Розгорни на цьому сервері «теми лекцій» для мого сайту taras.kyiv.ua (репозиторій GitHub `trs-hash/Films`).

## Що це

На YouTube я викладаю лекції (розмовна голова). Сайт групує їх за темами з файлу `lectures.json` у репозиторії.
Цей файл має формувати локальна ШІ-модель тут, на сервері: розшифрувати лекцію, зрозуміти, про що вона, і покласти
в широку тему (не плодити тем з 1–2 лекцій). Код уже готовий — `tools/lectures/lectures.py` (опис — `tools/lectures/README.md`).
Твоє завдання — встановити все потрібне, налаштувати й запустити за розкладом. Сам код без потреби не змінюй:
подальше налаштування тем я роблю в іншому місці; якщо щось у коді не працює на цьому сервері — виправ мінімально
й опиши в звіті, що саме.

## Кроки

1. **Подивись залізо й систему:** ОС, Python (потрібен ≥ 3.9), CPU (ядра), RAM, диск (треба ~25 ГБ вільних),
   відеокарта (`nvidia-smi`; якщо NVIDIA — драйвер і CUDA). Від цього залежить вибір моделей (крок 3).
2. **Склади репозиторій** у `/srv/films` (або інше місце — тоді впиши в config). Для запису потрібен **deploy key**:
   згенеруй ключ `ssh-keygen -t ed25519 -f ~/.ssh/films_deploy -N ""`, покажи мені публічну частину і попроси
   додати її: GitHub → trs-hash/Films → Settings → Deploy keys → Add deploy key, **Allow write access**.
   Налаштуй `~/.ssh/config` (Host github.com, IdentityFile ~/.ssh/films_deploy) і клонуй
   `git@github.com:trs-hash/Films.git`. Перевір `git push --dry-run`.
3. **Ollama** (https://ollama.com/download — офіційний скрипт встановлення), служба systemd, слухає лише
   `127.0.0.1:11434` (не відкривай назовні). Моделі:
   - мова: за залізом — відеокарта ≥ 16 ГБ або RAM ≥ 32 ГБ → `gemma3:12b`; відеокарта ≥ 24 ГБ → можна `gemma3:27b`;
     менше (RAM 16 ГБ, без GPU) → `gemma3:4b`. Мені потрібна добра українська — якщо є сумніви, порівняй дві моделі
     на одній розшифровці й обери ту, що краще пише українською;
   - відбитки: `bge-m3` (обовʼязково саме вона — пороги тем підібрані під неї).
   `ollama pull …` обидві.
4. **Розшифровка:** `apt install ffmpeg`; віртуальне середовище `/opt/films-lectures/venv` з `faster-whisper` і `yt-dlp`
   (`pip install -U faster-whisper yt-dlp`). Модель Whisper: є NVIDIA GPU → `large-v3`, `whisper_device: "cuda"`;
   лише CPU → `large-v3` з `int8`, якщо ≥ 8 ядер і ≥ 16 ГБ RAM, інакше `medium`. Перевір на 30 секундах будь-якого
   українського аудіо, скільки займає хвилина звуку, — напиши мені в звіті.
5. **Налаштування:** `cp tools/lectures/config.example.json tools/lectures/config.json` (файл у .gitignore — у git
   не потрапить) і заповни: `repo_dir`, `state_dir` (напр. `/var/lib/films-lectures`), `inbox_dir`
   (`/srv/lectures-inbox` — створи; туди я зможу класти оригінальні файли лекцій з назвою `<YouTube ID>.mp4`),
   `llm_model`, `whisper_model`, `whisper_device`. Ключ YouTube Data API: я дам — поклади в
   `/etc/films-lectures.env` як `YT_API_KEY=…` (права 600, власник — користувач служби), у config — `"ENV:YT_API_KEY"`.
6. **Перевірка:** `python3 tools/lectures/lectures.py check` — усе має бути ✅. Потім
   `python3 tools/lectures/lectures.py run --dry` — без публікації: подивись лог і `tools/lectures/report.md`.
   Якщо лекцій на YouTube ще нема чи мало — це нормально: тем ще не буде (тема — від 3 схожих лекцій).
7. **Якщо YouTube не дає субтитри чи звук** («Sign in to confirm you're not a bot» — так буває на серверах):
   скажи мені; варіанти — файл cookies з мого браузера (`yt_dlp_cookies`) або я кладу оригінали лекцій в `inbox_dir`.
8. **Розклад:** systemd-служба `films-lectures.service` (Type=oneshot, User — окремий користувач без sudo,
   EnvironmentFile=/etc/films-lectures.env, WorkingDirectory=repo_dir, ExecStart=`/opt/films-lectures/venv/bin/python
   tools/lectures/lectures.py run`) і таймер `films-lectures.timer` — щогодини (OnCalendar=hourly,
   RandomizedDelaySec=10min, Persistent=true). Одночасно — лише один запуск (flock або Type=oneshot достатньо).
   Логи — `journalctl -u films-lectures`.
9. **Перший справжній запуск:** `systemctl start films-lectures` — переконайся, що коміт «лекції: теми оновлено…»
   зʼявився в репозиторії (або в лозі «без змін у файлах сайту», якщо публікувати ще нічого).

## Безпека

- Ключ YouTube і deploy key — лише на сервері, у git нічого секретного.
- Deploy key — лише для цього репозиторію; служба працює від окремого користувача без sudo.
- Ollama — тільки на 127.0.0.1.
- Служба комітить лише `lectures.json` і `tools/lectures/report.md`.

## Звіт мені (коротко)

Залізо; які моделі обрав і чому; скільки триває розшифровка хвилини лекції й обробка однієї лекції повністю;
результат `check` і `run --dry`; що довелося змінити чи обійти; що потрібно від мене (публічний ключ для deploy key,
ключ YouTube, cookies — якщо треба).
