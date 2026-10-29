// Гавриїл → зустрічі на taras.kyiv.ua (керування подіями). Готовий шматок для бота на Node.js 18+ (без залежностей).
//
// Бот нічого не розбирає сам: пересилає текст команди в GitHub (workflow «Зустріч із бота»), а відповідь
// «✅ додано / ❌ що не так» надсилає в цей самий чат задача GitHub (секрет TG_BOT_TOKEN у репозиторії).
// Реєстрації й оплати — окремо, на сервері бота (див. PROMPT-zustrichi.md): тут лише сама подія на сайті.
//
// Команди (лише від власника — FILMS_OWNER_IDS):
//   /zustrich⏎дата: 14.11 19:00–21:00⏎назва: …⏎місто: …⏎місце: …⏎адреса: …⏎ціна: 300 | безкоштовно⏎місць: 40⏎опис: …
//   /zustrichi                       що на сайті
//   /skasuvaty [id | 14.11 | назва]   скасувати; /vidnovyty — повернути; /vydalyty — прибрати зовсім
//   /oplata online | onsite          платні: карткою через monobank чи на місці
//   /zustrichi_nalashtuvannia⏎api: https://…⏎telegram: ІмʼяБота
//
// Змінні середовища бота:
//   FILMS_GITHUB_TOKEN  fine-grained токен GitHub: лише репозиторій trs-hash/Films, дозвіл Actions — Read and write
//   FILMS_OWNER_IDS     твій Telegram user id (кілька — через кому); решті бот відмовляє

export const MEET_COMMANDS = ['zustrich', 'zustrichi', 'skasuvaty', 'vidnovyty', 'vydalyty', 'oplata', 'zustrichi_nalashtuvannia'];

export function isOwner(userId) {
    return String(process.env.FILMS_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(userId));
}

// Надсилає команду в GitHub. text — повний текст повідомлення з /командою; або action + data (поля обʼєктом) — для
// бота-асистента з інструментами. Повертає, що відповісти в чат одразу (результат прийде окремим повідомленням).
export async function filmsMeeting({ text = '', action = '', data = null, chatId }) {
    const token = process.env.FILMS_GITHUB_TOKEN;
    if (!token) return '❌ Нема FILMS_GITHUB_TOKEN — бот не може достукатися до сайту.';
    const inputs = { text: String(text).slice(0, 4000), chat_id: String(chatId ?? '') };
    if (action) inputs.action = String(action);
    if (data) inputs.data = JSON.stringify(data).slice(0, 4000);
    try {
        const res = await fetch('https://api.github.com/repos/trs-hash/Films/actions/workflows/meeting.yml/dispatches', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs }),
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 204) return '⏳ Прийняв. За хвилину відпишу, що вийшло.';
        return {
            401: '❌ GitHub не прийняв токен (FILMS_GITHUB_TOKEN недійсний або прострочений).',
            403: '❌ Токену бракує дозволу Actions: Read and write на trs-hash/Films.',
            404: '❌ GitHub не бачить репозиторій чи workflow meeting.yml (він має бути в main).',
            422: '❌ GitHub відхилив запит: workflow meeting.yml не знайдено в main або неправильні поля.',
        }[res.status] || `❌ GitHub відповів ${res.status}. Спробуй ще раз за хвилину.`;
    } catch (e) {
        return '❌ Не достукався до GitHub (мережа чи таймаут). Спробуй ще раз.';
    }
}
