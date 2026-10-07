// Гавриїл → збори на taras.kyiv.ua. Готовий шматок для бота на Node.js 18+ (без залежностей).
//
// Бот нічого не розбирає сам: пересилає текст команди в GitHub (workflow «Збір із бота»), а відповідь
// «✅ додано / ❌ що не так» надсилає в цей самий чат задача GitHub (якщо в репозиторії є секрет TG_BOT_TOKEN).
//
// Команди (лише від власника — FILMS_OWNER_IDS):
//   /zbir https://send.monobank.ua/jar/…       додати або оновити збір (назва, опис, ціль — із самої банки)
//   /zbir <посилання>⏎Назва⏎Опис⏎ціль 50000, до 31.12, благодійний   — те саме з власними даними
//   /zakryty [id | посилання | частина назви]   закрити збір
//   /zbory                                     що зараз на сайті
//
// Змінні середовища бота:
//   FILMS_GITHUB_TOKEN  fine-grained токен GitHub: лише репозиторій trs-hash/Films, дозвіл Actions — Read and write
//   FILMS_OWNER_IDS     твій Telegram user id (кілька — через кому); решті бот відмовляє

export const COMMANDS = ['zbir', 'zakryty', 'zbory'];

export function isOwner(userId) {
    return String(process.env.FILMS_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(userId));
}

// Надсилає команду в GitHub. Повертає, що відповісти в чат одразу (результат прийде окремим повідомленням).
export async function filmsZbir(text, chatId) {
    const token = process.env.FILMS_GITHUB_TOKEN;
    if (!token) return '❌ Нема FILMS_GITHUB_TOKEN — бот не може достукатися до сайту.';
    try {
        const res = await fetch('https://api.github.com/repos/trs-hash/Films/actions/workflows/fundraiser.yml/dispatches', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs: { text: String(text).slice(0, 4000), chat_id: String(chatId) } }),
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 204) return '⏳ Прийняв. За хвилину відпишу, що вийшло.';
        const hint = { 401: 'токен недійсний або прострочений', 403: 'токену бракує дозволу Actions: Read and write',
            404: 'нема доступу до репозиторію або workflow ще не в main', 422: 'workflow не знайдено в main' }[res.status]
            || (await res.text()).slice(0, 200);
        return `❌ GitHub не прийняв команду (${res.status}): ${hint}`;
    } catch (e) {
        return `❌ Не достукався до GitHub: ${e.message}`;
    }
}

// ── Приклад: grammY ─────────────────────────────────────────────────────────────
//   import { filmsZbir, isOwner, COMMANDS } from './films-zbir.mjs';
//   bot.command(COMMANDS, async ctx => {
//       if (!isOwner(ctx.from?.id)) return;
//       await ctx.reply(await filmsZbir(ctx.message.text, ctx.chat.id));
//   });
//
// ── Приклад: Telegraf ───────────────────────────────────────────────────────────
//   bot.command(COMMANDS, async ctx => {
//       if (!isOwner(ctx.from?.id)) return;
//       await ctx.reply(await filmsZbir(ctx.message.text, ctx.chat.id));
//   });
