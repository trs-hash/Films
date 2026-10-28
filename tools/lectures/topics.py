"""Теми лекцій: розкласти лекції по ШИРОКИХ темах і не плодити дрібних.

Чиста логіка без моделей — її тестує tests/test_topics.py. Моделі (назви тем, перевірка «чи пасує») підставляє
lectures.py через `namer` і `judge`.

Правила (числа — у config.json → "topics"):
  • тема зʼявляється лише тоді, коли набралось ≥ min_topic_size схожих лекцій (кластер середнього звʼязку
    з порогом cluster_threshold); поодинокі лекції чекають у «без теми» — на сайті це «Нові студії»;
  • нова лекція йде в найближчу тему, якщо схожість із її центром ≥ assign_threshold; у «сірій зоні»
    [gray_threshold, assign_threshold) вирішує модель (judge) — чи ширша тема охоплює лекцію;
  • дві теми з центрами, схожими ≥ merge_threshold, зливаються (назву дає модель — ширшу за обидві);
  • тем не більше max_topics: якщо більше — зливаємо найближчі пари;
  • правки власника (overrides.json) — найсильніші: rename (назва), lock (назву не чіпати, з іншими не зливати),
    merge (злити), pin (лекцію — в тему), split_off (лекцію — геть із теми, назад у «без теми»).

Стан (state/topics.json): {"topics": [{"id", "title", "about", "members": [ids], "locked": bool}], "seq": n}.
"""
import math
import re
import unicodedata

DEFAULTS = {
    "min_topic_size": 3,
    "assign_threshold": 0.62,
    "gray_threshold": 0.52,
    "cluster_threshold": 0.58,
    "merge_threshold": 0.80,
    "max_topics": 12,
}

# ── вектори ──
def dot(a, b):
    return sum(x * y for x, y in zip(a, b))

def norm(a):
    n = math.sqrt(dot(a, a))
    return [x / n for x in a] if n else list(a)

def cos(a, b):
    na, nb = math.sqrt(dot(a, a)), math.sqrt(dot(b, b))
    return dot(a, b) / (na * nb) if na and nb else 0.0

def centroid(vecs):
    vecs = [norm(v) for v in vecs if v]
    if not vecs:
        return []
    return norm([sum(col) / len(vecs) for col in zip(*vecs)])

# ── id теми: латиниця з назви (стабільний, при перейменуванні не змінюється) ──
UA = dict(zip("абвгґдеєжзиіїйклмнопрстуфхцчшщьюяʼ'", ["a", "b", "v", "h", "g", "d", "e", "ie", "zh", "z", "y", "i", "i", "i", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "iu", "ia", "", ""]))

def slug(title, taken=()):
    t = unicodedata.normalize("NFC", str(title)).lower()
    s = "".join(UA.get(ch, ch) for ch in t)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40].strip("-") or "tema"
    base, i = s, 2
    while s in taken:
        s = f"{base}-{i}"
        i += 1
    return s

# ── кластери середнього звʼязку (average linkage) з порогом схожості ──
def clusters(ids, emb, threshold):
    groups = [[i] for i in ids]
    def sim(g1, g2):
        return sum(cos(emb[a], emb[b]) for a in g1 for b in g2) / (len(g1) * len(g2))
    while len(groups) > 1:
        best, pair = threshold, None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                s = sim(groups[i], groups[j])
                if s >= best:
                    best, pair = s, (i, j)
        if not pair:
            break
        i, j = pair
        groups[i] = groups[i] + groups[j]
        del groups[j]
    return groups


class Topics:
    """state — словник зі state/topics.json; emb — {id лекції: вектор}; cfg — пороги (DEFAULTS + config.json)."""

    def __init__(self, state, emb, cfg=None, namer=None, judge=None, log=print):
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.topics = [dict(t, members=list(dict.fromkeys(t.get("members", []))), locked=bool(t.get("locked")))
                       for t in (state or {}).get("topics", [])]
        self.emb = emb
        self.namer = namer or (lambda lectures, existing, examples: {"title": "Тема", "about": ""})
        self.judge = judge or (lambda lecture, topic: False)
        self.log = log
        self.examples = []          # назви, які дав власник, — зразок «ширини» для моделі

    # ── допоміжне ──
    def ids(self):
        return {t["id"] for t in self.topics}

    def topic_of(self, vid):
        for t in self.topics:
            if vid in t["members"]:
                return t
        return None

    def center(self, t):
        return centroid([self.emb[m] for m in t["members"] if m in self.emb])

    def find(self, tid):
        return next((t for t in self.topics if t["id"] == tid), None)

    def drop_empty(self):
        self.topics = [t for t in self.topics if t["members"] or t["locked"]]

    def name(self, members):
        existing = [t["title"] for t in self.topics]
        r = self.namer(members, existing, self.examples) or {}
        title = str(r.get("title") or "Тема").strip()[:60]
        return title, str(r.get("about") or "").strip()[:200]

    # ── правки власника ──
    def apply_overrides(self, ov):
        ov = ov or {}
        for tid, title in (ov.get("rename") or {}).items():
            t = self.find(tid)
            if t:
                t["title"] = str(title)[:60]
                self.examples.append(t["title"])
        for tid, about in (ov.get("about") or {}).items():
            t = self.find(tid)
            if t:
                t["about"] = str(about)[:200]
        for group in ov.get("merge") or []:
            group = [g for g in group if self.find(g)]
            if len(group) > 1:
                keep = self.find(group[0])
                for g in group[1:]:
                    t = self.find(g)
                    keep["members"] += [m for m in t["members"] if m not in keep["members"]]
                    t["members"] = []
                    t["locked"] = False
                self.log(f"злито за правкою власника: {', '.join(group)} → {keep['id']}")
        for tid in ov.get("lock") or []:
            t = self.find(tid)
            if t:
                t["locked"] = True
        for vid in ov.get("split_off") or []:
            t = self.topic_of(vid)
            if t:
                t["members"].remove(vid)
        for vid, tid in (ov.get("pin") or {}).items():
            t = self.find(tid)
            if not t:
                continue
            old = self.topic_of(vid)
            if old and old is not t:
                old["members"].remove(vid)
            if vid not in t["members"]:
                t["members"].append(vid)
        self.pinned = set((ov.get("pin") or {}).keys())
        self.split = set(ov.get("split_off") or [])
        self.drop_empty()

    # ── 1) нові лекції — в наявні теми ──
    def assign(self, vids):
        c = self.cfg
        for vid in vids:
            if self.topic_of(vid) or vid not in self.emb or vid in getattr(self, "split", ()):
                continue
            scored = sorted(((cos(self.emb[vid], self.center(t)), t) for t in self.topics if t["members"]),
                            key=lambda x: -x[0])
            if not scored:
                continue
            s, t = scored[0]
            if s >= c["assign_threshold"] or (s >= c["gray_threshold"] and self.judge(vid, t)):
                t["members"].append(vid)
                self.log(f"{vid} → «{t['title']}» (схожість {s:.2f})")

    # ── 2) з «без теми» — нові теми, лише з ≥ min_topic_size схожих ──
    def grow(self, all_vids):
        c = self.cfg
        free = [v for v in all_vids if v in self.emb and not self.topic_of(v) and v not in getattr(self, "split", ())]
        for g in clusters(free, self.emb, c["cluster_threshold"]):
            if len(g) < c["min_topic_size"]:
                continue
            title, about = self.name(g)
            same = next((t for t in self.topics if t["title"].casefold() == title.casefold()), None)
            if same:                                   # модель назвала так само, як наявну тему — це та сама широка тема
                same["members"] += [m for m in g if m not in same["members"]]
                self.log(f"до теми «{same['title']}» — ще {len(g)} лекції (модель вважає їх тією ж темою)")
                continue
            tid = slug(title, self.ids())
            self.topics.append({"id": tid, "title": title, "about": about, "members": list(g), "locked": False})
            self.log(f"нова тема «{title}» ({tid}): {len(g)} лекції")

    # ── 3) злиття схожих тем і стеля кількості ──
    def merge_pair(self, a, b, why):
        keep, gone = (a, b) if (a["locked"] or len(a["members"]) >= len(b["members"])) else (b, a)
        keep["members"] += [m for m in gone["members"] if m not in keep["members"]]
        gone["members"] = []
        if not keep["locked"]:
            keep["title"], keep["about"] = self.name(keep["members"])
        self.log(f"злито ({why}): «{gone['title']}» → «{keep['title']}»")

    def consolidate(self):
        c = self.cfg
        while True:
            live = [t for t in self.topics if t["members"]]
            best, pair = None, None
            for i in range(len(live)):
                for j in range(i + 1, len(live)):
                    a, b = live[i], live[j]
                    if a["locked"] and b["locked"]:
                        continue                       # дві закріплені власником — не зливаємо
                    s = cos(self.center(a), self.center(b))
                    if best is None or s > best:
                        best, pair = s, (a, b)
            if not pair:
                break
            if best >= c["merge_threshold"]:
                self.merge_pair(*pair, f"схожість {best:.2f}")
            elif len(live) > c["max_topics"]:
                self.merge_pair(*pair, f"тем більше за {c['max_topics']}")
            else:
                break
            self.drop_empty()
        self.drop_empty()

    # ── 4) підчистка: тема, що «схудла» нижче min_topic_size (після правок), — віддати її лекції найближчим ──
    def dissolve_small(self):
        c = self.cfg
        for t in list(self.topics):
            if t["locked"] or len(t["members"]) >= c["min_topic_size"]:
                continue
            others = [o for o in self.topics if o is not t and o["members"]]
            members, t["members"] = t["members"], []
            for vid in members:
                if vid in getattr(self, "pinned", ()):
                    t["members"].append(vid)
                    continue
                scored = sorted(((cos(self.emb.get(vid, []), self.center(o)), o) for o in others), key=lambda x: -x[0])
                if scored and scored[0][0] >= c["gray_threshold"]:
                    scored[0][1]["members"].append(vid)
            if not t["members"]:
                self.log(f"тема «{t['title']}» розчинилась (менше {c['min_topic_size']} лекцій)")
        self.drop_empty()

    def run(self, all_vids, overrides=None):
        self.apply_overrides(overrides)
        self.assign(all_vids)
        self.grow(all_vids)
        self.consolidate()
        self.dissolve_small()
        self.assign(all_vids)                          # після злиттів «без теми» могли стати ближчими
        return self.state()

    def state(self):
        return {"topics": [{"id": t["id"], "title": t["title"], "about": t.get("about", ""), "members": t["members"],
                            "locked": t["locked"]} for t in self.topics]}


def site_json(state, videos, generated, model):
    """Те, що читає сайт (index.html → normLect): теми з лекціями й короткі дані про лекції."""
    order = {v: i for i, v in enumerate(sorted(videos, key=lambda v: videos[v].get("date", "")))}
    topics = []
    for t in state["topics"]:
        members = sorted([m for m in t["members"] if m in videos], key=lambda m: order[m])
        if members:
            topics.append({"id": t["id"], "title": t["title"], "about": t.get("about", ""), "videos": members})
    of = {m: t["id"] for t in topics for m in t["videos"]}
    vids = {}
    for v, d in videos.items():
        o = {}
        if v in of:
            o["topic"] = of[v]
        if d.get("dur"):
            o["dur"] = int(d["dur"])
        if d.get("summary"):
            o["summary"] = d["summary"][:400]
        vids[v] = o
    return {"version": 1, "generated": generated, "model": model, "topics": topics, "videos": vids}
