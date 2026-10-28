Розгорни на цьому сервері «теми лекцій» для мого сайту taras.kyiv.ua (репозиторій GitHub `trs-hash/Films`).

## Що це

На YouTube я викладаю лекції (розмовна голова). Сайт групує їх за темами з файлу `lectures.json` у репозиторії.
Цей файл має формувати локальна ШІ-модель тут, на сервері: розшифрувати лекцію, зрозуміти, про що вона, і покласти
в широку тему (не плодити тем з 1–2 лекцій). Код уже готовий — `tools/lectures/lectures.py` (опис — `tools/lectures/README.md`).
Твоє завдання — встановити все потрібне, налаштувати й запустити за розкладом. Сам код без потреби не змінюй:
подальше налаштування тем я роблю в іншому місці; якщо щось у коді не працює на цьому сервері — виправ мінімально
й опиши в звіті, що саме.

**Найімовірніше, Whisper (розпізнавання мови) на цьому сервері вже стоїть.** Тоді користуйся ним: другий Whisper
не встановлюй і модель вдруге не завантажуй.

## Кроки

1. **Подивись залізо й систему:** ОС, Python (потрібен ≥ 3.9), CPU (ядра), RAM, диск (треба ~25 ГБ вільних; якщо
   Whisper уже є — менше), відеокарта (`nvidia-smi`; якщо NVIDIA — драйвер, CUDA і скільки відеопамʼяті вже зайнято).
   Від цього залежить вибір моделей (крок 4).

2. **Спершу знайди наявний Whisper** — нічого ще не встановлюючи. Шукай усі види:
   - **служба** (найзручніше): `systemctl list-units --all | grep -i whisper`, `docker ps -a` (образи на кшталт
     `onerahmet/openai-whisper-asr-webservice`, `fedirz/faster-whisper-server`, `speaches`, `whisper.cpp`),
     `ss -ltnp` (хто слухає порти). З'ясуй адресу й API: OpenAI-сумісний `…/v1/audio/transcriptions`,
     whisper.cpp server `…/inference` чи whisper-asr-webservice `…/asr`;
   - **програма:** `which whisper whisper-cli whisper-cpp whisper-ctranslate2 whisperx`, збірки whisper.cpp
     (`find / -name 'whisper-cli' -o -name 'ggml-*.bin' 2>/dev/null`);
   - **бібліотека Python:** `faster_whisper` чи `whisper` (openai-whisper) — у системному Python, у venv / conda / pipx
     (`find / -path '*site-packages/faster_whisper' -o -path '*site-packages/whisper/__init__.py' 2>/dev/null`);
   - **уже завантажені моделі:** `~/.cache/huggingface/hub/models--Systran--faster-whisper-*`, `~/.cache/whisper/*.pt`,
     `ggml-*.bin` — у всіх користувачів.

   Запиши, що знайшов: вид, де лежить, яка модель (tiny / base / small / medium / large-v3), чи працює на GPU.
   **Наявний Whisper не оновлюй, не перевстановлюй, не перезапускай і не змінюй його налаштувань** — ним можуть
   користуватись інші мої речі. Якщо його модель мала (tiny / base / small) — українською вона розпізнає погано:
   не міняй сам, а напиши мені в звіті й запропонуй, що зробити.

3. **Склади репозиторій** у `/srv/films` (або інше місце — тоді впиши в config). Для запису потрібен **deploy key**:
   згенеруй ключ `ssh-keygen -t ed25519 -f ~/.ssh/films_deploy -N ""`, покажи мені публічну частину і попроси
   додати її: GitHub → trs-hash/Films → Settings → Deploy keys → Add deploy key, **Allow write access**.
   Налаштуй `~/.ssh/config` (Host github.com, IdentityFile ~/.ssh/films_deploy) і клонуй
   `git@github.com:trs-hash/Films.git`. Перевір `git push --dry-run`.

4. **Ollama** — якщо вже стоїть, користуйся наявною. Ні — https://ollama.com/download (офіційний скрипт), служба
   systemd, слухає лише `127.0.0.1:11434` (не відкривай назовні). Моделі:
   - мова: за залізом — відеокарта ≥ 16 ГБ або RAM ≥ 32 ГБ → `gemma3:12b`; відеокарта ≥ 24 ГБ → можна `gemma3:27b`;
     менше (RAM 16 ГБ, без GPU) → `gemma3:4b`. **Якщо відеокарту вже займає Whisper** — рахуй лише вільну
     відеопамʼять (або нехай модель працює з RAM). Мені потрібна добра українська — якщо є сумніви, порівняй дві моделі
     на одній розшифровці й обери ту, що краще пише українською;
   - відбитки: `bge-m3` (обовʼязково саме вона — пороги тем підібрані під неї).
   `ollama pull …` обидві.

5. **Розшифровка.** `ffmpeg` і `yt-dlp` потрібні в будь-якому разі (субтитри й звук з YouTube): `apt install ffmpeg`
   (якщо нема); віртуальне середовище `/opt/films-lectures/venv` з `pip install -U yt-dlp`. Далі — за кроком 2:

   **А. Whisper знайдено — підключи його** (`tools/lectures/config.json`, див. `whisper_*` у `config.example.json`):
   - служба → `"whisper_backend": "http"`, `"whisper_url": "http://127.0.0.1:ПОРТ/…"`; для whisper-asr-webservice —
     `"whisper_url": "…/asr?task=transcribe&language=uk&output=txt"`, `"whisper_file_field": "audio_file"`;
     для OpenAI-сумісної — `whisper_model` = назва моделі, яку чекає служба (або `""`), ключ (якщо є) — `whisper_api_key`;
   - програма → `"whisper_backend": "command"`, `"whisper_command"` — список аргументів із підстановками
     `{audio}`, `{wav}` (WAV 16 кГц — для whisper.cpp), `{out}` / `{outdir}` (куди писати текст), `{lang}`, `{model}`.
     Напр. whisper.cpp: `["/шлях/whisper-cli", "-m", "/шлях/ggml-large-v3.bin", "-l", "{lang}", "-otxt", "-of", "{out}", "-f", "{wav}"]`;
     CLI openai-whisper: `["/шлях/whisper", "{audio}", "--language", "{lang}", "--model", "large-v3", "--output_format", "txt", "--output_dir", "{outdir}"]`;
   - бібліотека Python у своєму venv → або запускай `lectures.py` пітоном того venv (крім Whisper, коду треба лише
     стандартна бібліотека; `yt-dlp` — у тому ж venv чи в PATH), `"whisper_backend": "faster-whisper"` / `"openai-whisper"`,
     або підключи як `command` (CLI того venv). Модель — та, що вже завантажена: `whisper_model` (назва чи шлях до теки
     моделі) і `whisper_download_root` (де лежать моделі), щоб нічого не качалось удруге.

   Користувач служби (крок 9) мусить мати доступ до наявного Whisper: до адреси служби, до програми й файлів моделі
   (лише читання; модель у чужій домашній теці — дай права на читання групі або скажи мені). Не роби копій моделей
   без потреби.

   **Б. Whisper нема — встанови** в той самий venv: `pip install -U faster-whisper`, `"whisper_backend": "faster-whisper"`.
   Модель: є NVIDIA GPU → `large-v3`, `whisper_device: "cuda"`; лише CPU → `large-v3` з `int8`, якщо ≥ 8 ядер і ≥ 16 ГБ RAM,
   інакше `medium`.

   **Перевір:** `python3 tools/lectures/lectures.py transcribe ФАЙЛ` на 30–60 секундах будь-якого українського аудіо —
   текст має бути розбірливою українською; напиши мені, скільки триває хвилина звуку.

6. **Налаштування:** `cp tools/lectures/config.example.json tools/lectures/config.json` (файл у .gitignore — у git
   не потрапить) і заповни: `repo_dir`, `state_dir` (напр. `/var/lib/films-lectures`), `inbox_dir`
   (`/srv/lectures-inbox` — створи; туди я зможу класти оригінальні файли лекцій з назвою `<YouTube ID>.mp4`),
   `llm_model`, `whisper_*` (крок 5). Ключ YouTube Data API: я дам — поклади в `/etc/films-lectures.env` як
   `YT_API_KEY=…` (права 600, власник — користувач служби), у config — `"ENV:YT_API_KEY"`.

7. **Перевірка:** `python3 tools/lectures/lectures.py check` — усе має бути ✅ (рядок Whisper показує, який саме
   підключено). Потім `python3 tools/lectures/lectures.py run --dry` — без публікації: подивись лог і
   `tools/lectures/report.md`. Якщо лекцій на YouTube ще нема чи мало — це нормально: тем ще не буде (тема — від 3 схожих лекцій).

8. **Якщо YouTube не дає субтитри чи звук** («Sign in to confirm you're not a bot» — так буває на серверах):
   скажи мені; варіанти — файл cookies з мого браузера (`yt_dlp_cookies`) або я кладу оригінали лекцій в `inbox_dir`.

9. **Розклад:** systemd-служба `films-lectures.service` (Type=oneshot, User — окремий користувач без sudo,
   EnvironmentFile=/etc/films-lectures.env, WorkingDirectory=repo_dir, ExecStart=`<python із кроку 5>
   tools/lectures/lectures.py run`) і таймер `films-lectures.timer` — щогодини (OnCalendar=hourly,
   RandomizedDelaySec=10min, Persistent=true). Одночасно — лише один запуск (flock або Type=oneshot достатньо).
   Логи — `journalctl -u films-lectures`. Перевір `check` і `transcribe` саме від імені цього користувача
   (`sudo -u … python3 …`).

10. **Перший справжній запуск:** `systemctl start films-lectures` — переконайся, що коміт «лекції: теми оновлено…»
    зʼявився в репозиторії (або в лозі «без змін у файлах сайту», якщо публікувати ще нічого).

## Безпека

- Ключ YouTube і deploy key — лише на сервері, у git нічого секретного.
- Deploy key — лише для цього репозиторію; служба працює від окремого користувача без sudo.
- Ollama — тільки на 127.0.0.1; Whisper-служба, якщо була відкрита назовні, — не чіпай, але напиши мені про це.
- Наявний Whisper і все, що ним користується, лишаються як були.
- Служба комітить лише `lectures.json` і `tools/lectures/report.md`.

## Звіт мені (коротко)

Залізо; **який Whisper знайшов (вид, де, модель, GPU чи CPU) і як підключив** — або що встановив, якщо не знайшов;
які мовні моделі обрав і чому; скільки триває розшифровка хвилини лекції й обробка однієї лекції повністю;
результат `check` і `run --dry`; що довелося змінити чи обійти; що потрібно від мене (публічний ключ для deploy key,
ключ YouTube, cookies, права на модель Whisper — якщо треба).
