#!/usr/bin/env python3
"""Enrich an existing daily JSON with token_map, audio paths, and stub questions.

Temporary dev helper — the production routine generates all this natively.
Used when the writer agent times out so we can test the new schema end-to-end.

Morphology resolution: prefers kiwipiepy (real Korean morphological analyzer) for
dict-form derivation. Falls back to heuristic best_dict_guess only when kiwipiepy
is unavailable or returns no content morpheme. This prevents the prior bug class
where universal ㄹ-drop turned nouns into fake verbs (서울 → 서우다, 정말 → 정마다).
"""
import json
import re
import sys
from pathlib import Path

# kiwipiepy is the real Korean morphological analyzer. We use it as the PRIMARY
# source of truth for dict-form derivation. The earlier heuristic best_dict_guess
# stays as a last-resort fallback for cases kiwi can't analyze (rare proper nouns,
# foreign-loan words, neologisms).
try:
    from kiwipiepy import Kiwi
    _KIWI = Kiwi()
except ImportError:
    _KIWI = None
    print("WARNING: kiwipiepy not installed; falling back to heuristic morphology only.\n"
          "         Run: pip install kiwipiepy", file=sys.stderr)


# Content tags from kiwipiepy. We extract the lemma of the FIRST content morpheme
# in a token; particles, endings, and copulas are skipped. This means 겨울은
# (winter+topic) → 겨울 (NNG), 심고 (plant+connective) → 심다 (VV).
_KIWI_CONTENT_TAGS = {
    'NNG': 'noun', 'NNP': 'noun', 'NNB': 'noun', 'NR': 'noun', 'NP': 'noun',
    'VV': 'verb',  'VX': 'verb',
    'VA': 'adjective',
    'MAG': 'adverb', 'MAJ': 'adverb',
    'MM':  'determiner',
    'IC':  'interjection',
    'XR':  'noun',  # XR = root, treat as nominal
    'SL':  'noun',  # foreign-language alphabetic → treat as proper noun
    'SH':  'noun',  # hanja
}


def kiwi_dict_form(token: str):
    """Use kiwipiepy to derive (dict_form, pos) for a surface token.
    Returns (str, str) tuple or None if kiwi unavailable / no content morpheme found.
    Strips particles and endings naturally — returns the lemma of the lexical root.
    """
    if _KIWI is None or not token:
        return None
    try:
        result = _KIWI.tokenize(token)
    except Exception:
        return None
    if not result:
        return None
    # First content morpheme wins. kiwi's `lemma` is already canonical:
    # verbs/adjectives end in -다, nouns are bare.
    for tok in result:
        pos = _KIWI_CONTENT_TAGS.get(tok.tag)
        if pos:
            return (tok.lemma, pos)
    return None


PARTICLES_SINGLE = ["을", "를", "이", "가", "은", "는", "의", "에", "로", "과", "와", "도", "만"]
PARTICLES_MULTI = ["이에요", "예요", "에서는", "에게는", "에서도", "에서", "에게", "부터", "까지", "으로", "이랑", "하고"]


def has_jongseong(ch: str) -> bool:
    """True if the syllable has a final consonant (batchim)."""
    if not ch:
        return False
    code = ord(ch)
    if code < 0xAC00 or code > 0xD7A3:
        return False
    return (code - 0xAC00) % 28 != 0


def noun_variants(base: str) -> list[str]:
    """Plausible particle combinations for a noun."""
    variants = [base]
    last = base[-1] if base else ""
    jong = has_jongseong(last)
    # Subject
    variants.append(base + ("이" if jong else "가"))
    variants.append(base + ("은" if jong else "는"))
    # Object
    variants.append(base + ("을" if jong else "를"))
    # Locations / topics
    variants.extend([base + p for p in ["에", "에서", "에서는", "에는", "에도", "의"]])
    # Conjunction / with / too
    variants.extend([base + "와", base + "과", base + "도", base + "만"])
    return list(dict.fromkeys(variants))  # dedup, preserve order


def verb_variants(da_form: str) -> list[str]:
    """Plausible conjugations for a -다-form verb/adjective.

    We don't try to do full morphology. We emit common polite and connective endings
    so the token_map catches them when a student taps.
    """
    if not da_form.endswith("다"):
        return [da_form]
    stem = da_form[:-1]
    variants = {da_form}
    # Polite present heuristic: stem + 어요/아요 (picking 어 by default; 오/아 vowels should prefer 아)
    # We can't know perfectly without morphology — sample both for safety
    variants.update([stem + "어요", stem + "아요", stem + "여요"])
    # 해요 special case
    if stem.endswith("하"):
        variants.add(stem[:-1] + "해요")
        variants.add(stem[:-1] + "해")
        variants.add(stem[:-1] + "해서")
        variants.add(stem[:-1] + "하고")
    # Connectives / others
    variants.update([stem + "고", stem + "지만", stem + "는데", stem + "면", stem + "어서", stem + "아서", stem + "여서", stem + "기", stem + "음", stem + "을"])
    # 려 ← 리 fusion: if stem ends in 리, also emit form with 려
    if stem.endswith("리"):
        variants.add(stem[:-1] + "려요")
        variants.add(stem[:-1] + "려")
    return list(variants)


def tokenize_text(text: str) -> list[str]:
    """Split text into whitespace-separated surface tokens, stripping end punctuation."""
    raw = re.split(r"\s+", text)
    out = []
    for t in raw:
        clean = re.sub(r"[.,!?。、·…~\-:;\"'()\[\]「」『』]+$", "", t)
        if clean:
            out.append(clean)
    return out


def _drop_final_jongseong(s: str, target_jamo: str) -> str | None:
    """If final syllable's jongseong matches target_jamo, drop it. Else None.
    Mirror of JS dropFinalJongseong used by reading.js."""
    if not s:
        return None
    last = ord(s[-1])
    if last < 0xAC00 or last > 0xD7A3:
        return None
    offset = last - 0xAC00
    jong = offset % 28
    if jong == 0:
        return None
    # Compatibility-jamo charcodes for each jongseong index
    jamo_table = [
        0x0000, 0x3131, 0x3132, 0x3133, 0x3134, 0x3135, 0x3136, 0x3137,
        0x3139, 0x313A, 0x313B, 0x313C, 0x313D, 0x313E, 0x313F, 0x3140,
        0x3141, 0x3142, 0x3144, 0x3145, 0x3146, 0x3147, 0x3148, 0x314A,
        0x314B, 0x314C, 0x314D, 0x314E,
    ]
    if jamo_table[jong] != ord(target_jamo):
        return None
    return s[:-1] + chr(last - jong)


def best_dict_guess(stripped: str) -> str | None:
    """Most-confident dict-form guess from a stripped stem.
    Mirror of JS bestDictGuess (only morphologically-motivated rules,
    no catch-all '+ 다'). Returns None when no rule fires.
    Used to populate token_map['unknown'] entries with a real dict form
    instead of self-mapping to the inflected surface."""
    if not stripped:
        return None
    s = stripped
    # -한 → -하다 (위한 → 위하다)
    if s.endswith("한") and len(s) > 1:
        return s[:-1] + "하다"
    if s.endswith("해서") and len(s) > 2:
        return s[:-2] + "하다"
    if s.endswith("해"):
        return s[:-1] + "하다"
    if s.endswith("하려고") and len(s) > 3:
        return s[:-3] + "하다"
    if s.endswith("려고") and len(s) > 2:
        return s[:-2] + "다"
    if s.endswith("와"):
        return s[:-1] + "오다"
    if s.endswith("워"):
        return s[:-1] + "우다"
    if s.endswith("던") and len(s) > 1:
        return s[:-1] + "다"
    if s.endswith("려"):
        return s[:-1] + "리다"
    if re.search(r"[어아여]서$", s) and len(s) > 1:
        return s[:-2] + "다"
    if re.search(r"[어아여]$", s):
        return s[:-1] + "다"
    if s.endswith("지만") and len(s) > 2:
        return s[:-2] + "다"
    if s.endswith("지") and len(s) > 1:
        return s[:-1] + "다"
    if s.endswith("니까") and len(s) > 2:
        return s[:-2] + "다"
    if s.endswith("니") and len(s) > 1:
        return s[:-1] + "다"
    if s.endswith("으면") and len(s) > 2:
        return s[:-2] + "다"
    if s.endswith("면") and len(s) > 1:
        return s[:-1] + "다"
    if s.endswith("게") and len(s) > 1:
        return s[:-1] + "다"
    if s.endswith("고") and len(s) > 1:
        return s[:-1] + "다"
    # ㄹ-future: 즐길 → 즐기다, 올 → 오다
    l_stem = _drop_final_jongseong(s, "ㄹ")
    if l_stem:
        return l_stem + "다"
    return None


def build_token_map(level_data: dict) -> dict:
    """Derive token_map from the level's vocab and tokenize text to catch surface forms."""
    vocab = level_data.get("vocab", [])
    by_base = {v["kr"]: v for v in vocab}
    tm = {}

    # 1) generate variants for each vocab entry
    for v in vocab:
        base = v["kr"]
        pos = v.get("pos", "")
        en = v.get("en", "")
        # If it's a verb/adjective (ends in 다), emit conjugation variants
        if base.endswith("다"):
            for var in verb_variants(base):
                tm.setdefault(var, {"dict": base, "en": en, "pos": pos or "verb", "gloss": _gloss_for(var, base)})
        else:
            for var in noun_variants(base):
                tm.setdefault(var, {"dict": base, "en": en, "pos": pos or "noun"})

    # 2) for every whitespace token in the text, if not already in map, add a minimal entry.
    #    Resolution priority:
    #      (a) kiwipiepy → real morphology, knows nouns vs verbs (PRIMARY)
    #      (b) particle-strip → vocab-list lookup (catches noun + non-particle suffix combos)
    #      (c) best_dict_guess heuristic (LAST RESORT — only for tokens kiwi can't analyze)
    for tok in tokenize_text(level_data.get("text", "")):
        if tok in tm:
            continue

        # (a) kiwipiepy is authoritative when available.
        kiwi_result = kiwi_dict_form(tok)
        if kiwi_result:
            dict_form, pos = kiwi_result
            # Cross-reference with vocab list to enrich the entry's en/def/gloss.
            v = by_base.get(dict_form)
            if v:
                tm[tok] = {"dict": dict_form, "en": v.get("en", ""), "pos": v.get("pos", pos)}
            else:
                tm[tok] = {"dict": dict_form, "en": "", "pos": pos}
            continue

        # (b) try noun-strip + vocab match (covers compound + particle cases kiwi missed).
        stripped = _strip_particles(tok)
        if stripped in by_base:
            v = by_base[stripped]
            tm[tok] = {"dict": stripped, "en": v.get("en", ""), "pos": v.get("pos", "noun")}
            continue

        # (c) Heuristic last resort. The earlier bug class (서울 → 서우다, 정말 → 정마다)
        # came from this rule firing on nouns. Now it only runs when kiwi has already
        # said "no content morpheme found" — which for real Korean text is rare.
        guess = best_dict_guess(stripped or tok)
        if guess and guess != tok:
            tm[tok] = {"dict": guess, "en": "", "pos": "verb"}
        # else: leave the token absent. resolveTap on the client will then run
        # its own morphology fallback (bestDictGuess + heuristic strip) and
        # land on the right answer.

    # sort keys for determinism
    return dict(sorted(tm.items()))


def _strip_particles(tok: str) -> str:
    """Single-pass particle stripping. For determinism more than accuracy."""
    for p in sorted(PARTICLES_MULTI, key=len, reverse=True):
        if len(tok) > len(p) and tok.endswith(p):
            return tok[:-len(p)]
    for p in PARTICLES_SINGLE:
        if len(tok) > 1 and tok.endswith(p):
            return tok[:-1]
    return tok


def _gloss_for(variant: str, base: str) -> str:
    if variant == base:
        return ""
    if variant.endswith("어요") or variant.endswith("아요") or variant.endswith("여요") or variant.endswith("해요"):
        return "polite-present"
    if variant.endswith("고"):
        return "connective -고"
    if variant.endswith("지만"):
        return "contrastive -지만"
    if variant.endswith("는데"):
        return "background -는데"
    if variant.endswith("면"):
        return "conditional -면"
    if variant.endswith("서"):
        return "sequential/causal -서"
    if variant.endswith("기"):
        return "nominalization -기"
    if variant.endswith("음"):
        return "nominalization -음"
    if variant.endswith("을") or variant.endswith("ㄹ"):
        return "future modifier -ㄹ/-을"
    if variant.endswith("려") or variant.endswith("려요"):
        return "polite-present (려 from 리)"
    return ""


def stub_questions(level_key: str, topic_title: str) -> list[dict]:
    """Generic comprehension questions usable for any passage.
    Production routine generates real ones; this is a dev stub only."""
    counts = {"k1": 3, "k2": 4, "k3": 5, "k4": 6}
    templates = [
        ("short",  "이 글의 주제는 무엇이에요?",                 "Main topic of the passage."),
        ("yesno",  "이 글은 한국에 관한 글이에요?",               "Is this about Korea?"),
        ("short",  "이 글에서 가장 중요한 단어는 무엇이에요?",     "Most important word."),
        ("long",   "이 글을 읽고 무엇을 알게 되었나요?",           "What did you learn?"),
        ("short",  "이 글에 나오는 장소는 어디인가요?",            "Which place?"),
        ("long",   "이 글의 주장에 동의하나요? 왜 그런가요?",       "Agree / why?"),
    ]
    out = []
    n = counts.get(level_key, 3)
    for i, (typ, q, hint) in enumerate(templates[:n], 1):
        out.append({"id": f"q{i}", "type": typ, "q_kr": q, "answer_hint": hint})
    return out


def upgrade(data: dict) -> dict:
    date = data.get("date", "")
    for topic in data.get("topics", []):
        tid = topic["id"]
        for lkey, level in topic.get("levels", {}).items():
            level["audio"] = f"audio/{date}/{tid}_{lkey}.mp3"
            level["token_map"] = build_token_map(level)
            # preserve existing questions if any; else stub
            if not level.get("questions"):
                level["questions"] = stub_questions(lkey, level.get("title", ""))
            # ensure vocab has pos field
            for v in level.get("vocab", []):
                v.setdefault("pos", "")
    # sort topics by category, id
    data["topics"].sort(key=lambda t: (t.get("category", ""), t.get("id", "")))
    return data


def main(path: str) -> int:
    p = Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))
    data = upgrade(data)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False), encoding="utf-8")
    # also copy to latest.json
    latest = p.parent / "latest.json"
    latest.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False), encoding="utf-8")
    print(f"Upgraded {p.name}: {len(data['topics'])} topic(s), token_maps and questions added.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: upgrade_sample.py <path-to-daily-json>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
