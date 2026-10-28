"""Тести правил тем (без моделей): python3 -m unittest tools/lectures/test_topics.py  (або з tests/qa.js, кейс LT01).

Відбитки лекцій — штучні: кілька «напрямів» (тем) + шум; схожість усередині напряму ~0.9, між напрямами ~0.
"""
import json
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import topics as T  # noqa: E402
import lectures as L  # noqa: E402

DIM = 48


def direction(rng):
    return T.norm([rng.gauss(0, 1) for _ in range(DIM)])


def near(rng, d, noise=0.25):
    return T.norm([x + rng.gauss(0, noise / math.sqrt(DIM)) for x in d])   # шум ~0.25 → схожість із напрямом ~0.97


def mix(a, b, wa):
    return T.norm([wa * x + (1 - wa) * y for x, y in zip(a, b)])


class Namer:
    """Підставна «модель»: назва теми — з першого слова лекцій (як підказка, а не правда)."""
    def __init__(self):
        self.calls = []

    def __call__(self, members, existing, examples):
        self.calls.append((list(members), list(existing), list(examples)))
        return {"title": "Тема " + "-".join(sorted(m.split("_")[0] for m in members))[:20], "about": "опис"}


class TopicsTest(unittest.TestCase):
    def setUp(self):
        self.rng = random.Random(7)
        self.A, self.B, self.C = (direction(self.rng) for _ in range(3))

    def make(self, spec):
        """spec: {'a': (A, 3)} → відбитки a_1..a_3 біля напряму A"""
        emb = {}
        for p, (d, n) in spec.items():
            for i in range(1, n + 1):
                emb[f"{p}_{i}"] = near(self.rng, d)
        return emb

    def test_no_topics_from_one_or_two(self):
        emb = self.make({"a": (self.A, 2), "b": (self.B, 1), "c": (self.C, 2)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        self.assertEqual(st["topics"], [])          # 1–2 лекції — не тема: чекають у «Нові студії»

    def test_three_similar_make_one_topic(self):
        emb = self.make({"a": (self.A, 3), "b": (self.B, 2)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        self.assertEqual(len(st["topics"]), 1)
        self.assertEqual(sorted(st["topics"][0]["members"]), ["a_1", "a_2", "a_3"])

    def test_new_lecture_joins_existing_topic(self):
        emb = self.make({"a": (self.A, 3)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        emb["a_4"] = near(self.rng, self.A)
        emb["b_1"] = near(self.rng, self.B)
        st = T.Topics(st, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        self.assertEqual(len(st["topics"]), 1)
        self.assertIn("a_4", st["topics"][0]["members"])
        self.assertNotIn("b_1", st["topics"][0]["members"])

    def test_gray_zone_asks_judge(self):
        emb = self.make({"a": (self.A, 3)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        center = T.centroid([emb[k] for k in emb])
        lo, hi = 0.0, 1.0                           # вага, за якої схожість із центром ~0.57 — сіра зона
        for _ in range(40):
            w = (lo + hi) / 2
            lo, hi = (w, hi) if T.cos(mix(center, self.B, w), center) < 0.57 else (lo, w)
        emb["x"] = mix(center, self.B, (lo + hi) / 2)
        s = T.cos(emb["x"], center)
        self.assertTrue(T.DEFAULTS["gray_threshold"] <= s < T.DEFAULTS["assign_threshold"], s)
        asked = []
        st2 = T.Topics(json.loads(json.dumps(st)), emb, namer=Namer(), judge=lambda v, t: asked.append(v) or True, log=lambda *_: None).run(list(emb))
        self.assertEqual(asked, ["x"])
        self.assertIn("x", st2["topics"][0]["members"])
        st3 = T.Topics(json.loads(json.dumps(st)), emb, namer=Namer(), judge=lambda v, t: False, log=lambda *_: None).run(list(emb))
        self.assertNotIn("x", st3["topics"][0]["members"])

    def test_similar_topics_merge_into_broader(self):
        emb = self.make({"a": (self.A, 3)})
        A2 = mix(self.A, direction(self.rng), 0.93)    # дуже близький напрям — те саме по суті
        for i in range(1, 4):
            emb[f"z_{i}"] = near(self.rng, A2)
        # дві теми вже є окремо (так могло статися раніше) — злиття має їх обʼєднати
        state = {"topics": [{"id": "a", "title": "А", "members": ["a_1", "a_2", "a_3"]}, {"id": "z", "title": "Я", "members": ["z_1", "z_2", "z_3"]}]}
        namer = Namer()
        st = T.Topics(state, emb, namer=namer, log=lambda *_: None).run(list(emb))
        self.assertEqual(len(st["topics"]), 1)
        self.assertEqual(len(st["topics"][0]["members"]), 6)
        self.assertTrue(namer.calls)                # назву злитої теми дала модель (ширшу)

    def test_max_topics_cap(self):
        rng = random.Random(3)
        emb = {}
        for k in range(5):
            d = direction(rng)
            for i in range(1, 4):
                emb[f"t{k}_{i}"] = near(rng, d)
        st = T.Topics({}, emb, cfg={"max_topics": 3}, namer=Namer(), log=lambda *_: None).run(list(emb))
        self.assertLessEqual(len(st["topics"]), 3)
        self.assertEqual(sum(len(t["members"]) for t in st["topics"]), 15)   # жодна лекція не загубилась

    def test_owner_overrides(self):
        emb = self.make({"a": (self.A, 3), "b": (self.B, 3)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        ta = next(t for t in st["topics"] if "a_1" in t["members"])
        tb = next(t for t in st["topics"] if "b_1" in t["members"])
        ov = {"rename": {ta["id"]: "Звички й воля"}, "lock": [ta["id"]], "pin": {"b_1": ta["id"]}}
        namer = Namer()
        st2 = T.Topics(st, emb, namer=namer, log=lambda *_: None).run(list(emb), ov)
        t2 = next(t for t in st2["topics"] if t["id"] == ta["id"])
        self.assertEqual(t2["title"], "Звички й воля")      # перейменування живе й після запуску
        self.assertTrue(t2["locked"])
        self.assertIn("b_1", t2["members"])                  # закріплена лекція там, куди поставив власник
        # друга тема схудла до 2 лекцій — розчиняється, лекції або в схожу тему, або в «без теми»; закріплена — на місці
        self.assertFalse(any(t["id"] == tb["id"] and len(t["members"]) < 3 for t in st2["topics"]))
        # merge: дві теми власник зливає явно
        st3 = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        ids = [t["id"] for t in st3["topics"]]
        st4 = T.Topics(st3, emb, namer=Namer(), log=lambda *_: None).run(list(emb), {"merge": [ids]})
        self.assertEqual(len(st4["topics"]), 1)
        # приклади назв від власника потрапляють до моделі
        emb.update({f"c_{i}": near(self.rng, self.C) for i in range(1, 4)})
        n = Namer()
        T.Topics(st2, emb, namer=n, log=lambda *_: None).run(list(emb), ov)
        self.assertTrue(any("Звички й воля" in c[2] for c in n.calls))

    def test_same_name_from_model_joins_existing_topic(self):
        emb = self.make({"a": (self.A, 3)})
        st = T.Topics({}, emb, namer=lambda *a: {"title": "Звички й воля"}, log=lambda *_: None).run(list(emb))
        emb.update({f"b_{i}": near(self.rng, self.B) for i in range(1, 4)})
        st2 = T.Topics(st, emb, namer=lambda *a: {"title": "звички Й воля"}, log=lambda *_: None).run(list(emb))
        self.assertEqual(len(st2["topics"]), 1)                    # не дві однакові теми на сайті
        self.assertEqual(len(st2["topics"][0]["members"]), 6)

    def test_split_off(self):
        emb = self.make({"a": (self.A, 4)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        st2 = T.Topics(st, emb, namer=Namer(), log=lambda *_: None).run(list(emb), {"split_off": ["a_4"]})
        self.assertNotIn("a_4", st2["topics"][0]["members"])

    def test_site_json_shape(self):
        emb = self.make({"a": (self.A, 3), "b": (self.B, 1)})
        st = T.Topics({}, emb, namer=Namer(), log=lambda *_: None).run(list(emb))
        videos = {k: {"date": f"2026-11-0{i + 1}", "dur": 2400, "summary": "Зміст."} for i, k in enumerate(sorted(emb))}
        out = T.site_json(st, videos, "2026-11-05T12:00:00+02:00", {"llm": "x"})
        self.assertEqual(out["version"], 1)
        t = out["topics"][0]
        self.assertRegex(t["id"], r"^[\w-]+$")
        self.assertEqual(t["videos"], ["a_1", "a_2", "a_3"])           # хронологічно
        self.assertNotIn("topic", out["videos"]["b_1"])                 # без теми → на сайті «Нові студії»
        self.assertEqual(out["videos"]["a_1"], {"topic": t["id"], "dur": 2400, "summary": "Зміст."})

    def test_slug(self):
        self.assertEqual(T.slug("Звички й воля"), "zvychky-i-volia")
        self.assertEqual(T.slug("Стоїцизм", {"stoitsyzm"}), "stoitsyzm-2")
        self.assertEqual(T.slug("!!!"), "tema")


class PipelineHelpersTest(unittest.TestCase):
    def test_vtt_to_text_dedupes_rolling_captions(self):
        vtt = """WEBVTT
Kind: captions
Language: uk

00:00:00.000 --> 00:00:02.000 align:start position:0%
Привіт<00:00:00.500><c> друзі</c>

00:00:02.000 --> 00:00:04.000
Привіт друзі
сьогодні про звички

00:00:04.000 --> 00:00:06.000
сьогодні про звички
і волю
"""
        self.assertEqual(L.vtt_to_text(vtt), "Привіт друзі сьогодні про звички і волю")

    def test_chunks_cover_text(self):
        words = " ".join(f"w{i}" for i in range(5000))
        parts = L.chunks(words, 1800)
        self.assertEqual(len(parts), 3)
        self.assertEqual(" ".join(parts).split(), words.split())

    def test_parse_iso_duration(self):
        self.assertEqual(L.iso_dur("PT1H2M3S"), 3723)
        self.assertEqual(L.iso_dur("PT45M"), 2700)
        self.assertEqual(L.iso_dur("x"), 0)

    def test_json_from_model_tolerates_wrapping(self):
        self.assertEqual(L.json_from("Ось:\n```json\n{\"title\": \"Стоїцизм\"}\n```"), {"title": "Стоїцизм"})
        self.assertEqual(L.json_from("сміття"), {})


if __name__ == "__main__":
    unittest.main()
