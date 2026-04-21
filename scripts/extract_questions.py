"""
One-time extraction of CEN 800 quiz questions from the PDFs in ./Questions
into ./data/question_bank.json.

Run once with:
    python scripts/extract_questions.py

The app reads the resulting JSON directly. Re-running this script overwrites
data/question_bank.json.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS_DIR = ROOT / "Questions"
DATA_DIR = ROOT / "data"
OUT_FILE = DATA_DIR / "question_bank.json"

# Maps each PDF filename to (source, topic, id_prefix).
# The project spec uses "Lecture" (singular); real files use "Lectures".
# Some files have been revised; the " V2" variants replace the originals.
FILE_MAP = {
    "Lectures 7 & 8 - Part 1.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lectures 7 & 8 - Part 2.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lectures 7 & 8 - Part 3.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lectures 7 & 8 - Part 3 V2.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lecture 7 & 8 - Part 1.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lecture 7 & 8 - Part 2.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lecture 7 & 8 - Part 3.pdf": ("Lecture 7 & 8", "Lecture 7 & 8", "L78"),
    "Lectures 9 & 10 - Part 1.pdf": ("Lecture 9 & 10", "Lecture 9 & 10", "L910"),
    "Lectures 9 & 10 - Part 2.pdf": ("Lecture 9 & 10", "Lecture 9 & 10", "L910"),
    "Lecture 9 & 10 - Part 1.pdf": ("Lecture 9 & 10", "Lecture 9 & 10", "L910"),
    "Lecture 9 & 10 - Part 2.pdf": ("Lecture 9 & 10", "Lecture 9 & 10", "L910"),
    "Lectures 11 & 12.pdf": ("Lecture 11 & 12", "Lecture 11 & 12", "L1112"),
    "Lecture 11 & 12.pdf": ("Lecture 11 & 12", "Lecture 11 & 12", "L1112"),
    "Extra Questions.pdf": ("Extra", "Extra Questions", "EXT"),
    "Extra Questions V2.pdf": ("Extra", "Extra Questions", "EXT"),
}

# Processing order so IDs are stable. V2 files take the slot of the originals.
PROCESS_ORDER = [
    "Lectures 7 & 8 - Part 1.pdf",
    "Lecture 7 & 8 - Part 1.pdf",
    "Lectures 7 & 8 - Part 2.pdf",
    "Lecture 7 & 8 - Part 2.pdf",
    "Lectures 7 & 8 - Part 3 V2.pdf",
    "Lectures 7 & 8 - Part 3.pdf",
    "Lecture 7 & 8 - Part 3.pdf",
    "Lectures 9 & 10 - Part 1.pdf",
    "Lecture 9 & 10 - Part 1.pdf",
    "Lectures 9 & 10 - Part 2.pdf",
    "Lecture 9 & 10 - Part 2.pdf",
    "Lectures 11 & 12.pdf",
    "Lecture 11 & 12.pdf",
    "Extra Questions V2.pdf",
    "Extra Questions.pdf",
]

# -------- text cleanup --------

ZERO_WIDTH = {"\u200b", "\u200c", "\u200d", "\ufeff"}
BULLETS = {"\u2022", "\u25cf", "\u25aa"}


def clean_text(raw: str) -> str:
    """Normalize unicode, strip zero-width chars, collapse whitespace per-line."""
    text = unicodedata.normalize("NFKC", raw)
    for z in ZERO_WIDTH:
        text = text.replace(z, "")
    for b in BULLETS:
        text = text.replace(b, "")
    # Replace non-breaking spaces with regular spaces.
    text = text.replace("\u00a0", " ")
    # Normalize curly quotes / dashes.
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    return text


def load_pdf_text(path: Path) -> str:
    doc = fitz.open(path)
    try:
        pages = [page.get_text() for page in doc]
    finally:
        doc.close()
    return clean_text("\n".join(pages))


# -------- parsing --------

# Matches a question start at beginning of a line: "12. ...". Allowing up to
# three digits avoids matching things like "Furnace 3000." in a scenario body.
QUESTION_START = re.compile(r"^(\d{1,3})\.\s+(.*)$")
# Matches a choice line: " a) ..." or "a) ..."
CHOICE_LINE = re.compile(r"^\s*([a-eA-E])\)\s*(.*)$")
# Matches an answer line: "Answer: b" possibly followed by whitespace.
ANSWER_LINE = re.compile(r"^\s*Answer\s*:\s*([a-eA-E])\b", re.IGNORECASE)
# Header noise like "Questions 1 to 25"
SECTION_HEADER = re.compile(r"^\s*Questions\s+\d+\s+to\s+\d+\s*$", re.IGNORECASE)


def _collapse_multiline(lines: list[str]) -> list[str]:
    """
    PDF extraction splits long question stems / choices across multiple
    visual lines. We reattach continuation lines to the current logical line.

    A "new logical line" is any line that starts with:
      - "N. "   (question start)
      - "a)"..."e)" (choice)
      - "Answer:" (answer)
      - blank (paragraph break)
    Everything else is a continuation of the previous logical line.
    """
    logical: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            # Blank lines close the current logical line.
            if logical and logical[-1] != "":
                logical.append("")
            continue
        if (
            QUESTION_START.match(line)
            or CHOICE_LINE.match(line)
            or ANSWER_LINE.match(line)
            or SECTION_HEADER.match(line)
        ):
            logical.append(line.strip())
        else:
            if logical and logical[-1] and not (
                QUESTION_START.match(logical[-1])
                or CHOICE_LINE.match(logical[-1])
                or ANSWER_LINE.match(logical[-1])
                or SECTION_HEADER.match(logical[-1])
            ):
                # Continuation of a free-text line (scenario header or stray).
                logical[-1] = (logical[-1] + " " + line.strip()).strip()
            elif logical and logical[-1]:
                # Continuation of the previous question / choice / etc.
                logical[-1] = (logical[-1] + " " + line.strip()).strip()
            else:
                logical.append(line.strip())
    # Drop leading/trailing empties.
    while logical and logical[0] == "":
        logical.pop(0)
    while logical and logical[-1] == "":
        logical.pop()
    return logical


def parse_questions(text: str) -> tuple[list[dict], list[tuple[str, str]]]:
    """
    Parse a cleaned PDF text blob into a list of raw question dicts plus
    a list of (reason, excerpt) skips.

    Returned raw dict fields:
      number, stem, choices (dict letter->text), answer (letter|None),
      scenario (str|None), scenario_block (int|None)
    """
    lines = _collapse_multiline(text.split("\n"))

    questions: list[dict] = []
    skips: list[tuple[str, str]] = []
    current_scenario: str | None = None
    # Optional inclusive range (start, end) during which the scenario applies.
    current_scenario_range: tuple[int, int] | None = None
    # Monotonically increasing id for each scenario block we encounter so
    # identical scenario text across files / reuses stay distinct groups.
    current_scenario_block: int | None = None
    scenario_block_counter = 0
    current: dict | None = None

    scenario_range_re = re.compile(
        r"Questions?\s+(\d+)\s*(?:to|-|\u2013)\s*(\d+)", re.IGNORECASE
    )

    def start_scenario(text_: str) -> None:
        nonlocal current_scenario, current_scenario_range, current_scenario_block
        nonlocal scenario_block_counter
        current_scenario = text_.rstrip(".")
        rm = scenario_range_re.search(text_)
        current_scenario_range = (
            (int(rm.group(1)), int(rm.group(2))) if rm else None
        )
        scenario_block_counter += 1
        current_scenario_block = scenario_block_counter

    def clear_scenario() -> None:
        nonlocal current_scenario, current_scenario_range, current_scenario_block
        current_scenario = None
        current_scenario_range = None
        current_scenario_block = None

    def close_current() -> None:
        nonlocal current
        if current is not None:
            questions.append(current)
            current = None

    for line in lines:
        if not line:
            continue
        if SECTION_HEADER.match(line):
            continue

        m_q = QUESTION_START.match(line)
        if m_q:
            close_current()
            number, stem = m_q.group(1), m_q.group(2).strip()
            num = int(number)
            # Expire a range-bound scenario once we move past it.
            if current_scenario_range is not None:
                lo, hi = current_scenario_range
                if num > hi:
                    clear_scenario()
            # Only attach the scenario if it applies to this number.
            scenario_for_q: str | None = current_scenario
            block_for_q: int | None = current_scenario_block
            if current_scenario_range is not None:
                lo, hi = current_scenario_range
                if not (lo <= num <= hi):
                    scenario_for_q = None
                    block_for_q = None
            current = {
                "number": num,
                "stem": stem,
                "choices": {},
                "answer": None,
                "scenario": scenario_for_q,
                "scenario_block": block_for_q,
            }
            continue

        m_c = CHOICE_LINE.match(line)
        if m_c and current is not None:
            letter = m_c.group(1).upper()
            body = m_c.group(2).strip()
            current["choices"][letter] = body
            continue

        m_a = ANSWER_LINE.match(line)
        if m_a and current is not None:
            current["answer"] = m_a.group(1).upper()
            # A scenario label can be stuck to the end of the answer line,
            # e.g. "Answer: c Foundation and Ground Inc."
            tail = line[m_a.end():].strip()
            close_current()
            if tail and not SECTION_HEADER.match(tail):
                start_scenario(tail)
            continue

        # Free-text line outside a question block. If we don't yet have a
        # scenario, this line starts one. If we already have a scenario but
        # haven't seen the next question, this is another paragraph of the
        # same scenario body - append it rather than starting a new block.
        if current is None:
            if not line.lower().startswith(("answer", "questions ")):
                if current_scenario is not None:
                    current_scenario = (
                        current_scenario + " " + line.strip()
                    ).rstrip(".")
                else:
                    start_scenario(line.strip())
        else:
            # Inside a question but before any choices or answer: stem continuation.
            if not current["choices"] and current["answer"] is None:
                current["stem"] = (current["stem"] + " " + line).strip()

    close_current()
    return questions, skips


# -------- classification / validation --------


# Boilerplate that means a scenario is referenced but never actually written
# out (e.g. "Scenario for Questions 26 to 30 Read the following scenario and
# answer the five questions that follow"). Those questions cannot be answered
# without the missing context, so we skip them.
_PLACEHOLDER_BOILERPLATE = re.compile(
    r"Read\s+the\s+following\s+scenario\s+and\s+answer\s+"
    r"the\s+\w+\s+questions?\s+that\s+follow\.?",
    re.IGNORECASE,
)
_SCENARIO_PREFIX = re.compile(
    r"^\s*Scenario\s+for\s+Questions?\s+\d+\s*(?:to|-|\u2013)\s*\d+\s*",
    re.IGNORECASE,
)


def is_placeholder_scenario(text: str | None) -> bool:
    """
    A "placeholder" scenario is one that says
        "Scenario for Questions X to Y Read the following scenario and
         answer the N questions that follow"
    but never provides the scenario body. Those questions can't be answered,
    so we drop them.

    Short free-text titles like "Hot Furnaces R Us" are NOT placeholders.
    They identify a scenario; the student is expected to use the title as
    the frame for the questions.
    """
    if not text:
        return False
    m = _SCENARIO_PREFIX.match(text)
    if not m:
        # Not a "Scenario for Questions X to Y" block - treat as a title.
        return False
    body = text[m.end():].strip()
    body_no_boilerplate = _PLACEHOLDER_BOILERPLATE.sub("", body).strip(" .")
    return len(body_no_boilerplate) < 20


def classify_and_validate(raw: dict) -> tuple[dict | None, str | None]:
    """Convert a raw parsed question into a validated record, or return a skip reason."""
    stem = raw.get("stem", "").strip()
    choices = raw.get("choices", {}) or {}
    answer = raw.get("answer")

    if not stem:
        return None, "empty stem"
    if not choices:
        return None, "no choices"
    if answer is None:
        return None, "missing answer"
    if answer not in choices:
        return None, f"answer letter '{answer}' not in choices {sorted(choices)}"

    # Tidy up choice text (strip trailing punctuation/whitespace but keep content).
    choices = {k: v.strip() for k, v in choices.items()}

    # Detect true/false: exactly two choices and both look like T/F variants.
    tf_values = {"TRUE", "FALSE", "T", "F"}
    choice_letters = sorted(choices.keys())
    is_tf = (
        choice_letters == ["A", "B"]
        and choices["A"].strip().upper().rstrip(".") in tf_values
        and choices["B"].strip().upper().rstrip(".") in tf_values
    )

    if is_tf:
        qtype = "true_false"
        # Normalize presentation.
        norm = {"A": "True", "B": "False"}
        # Keep semantic meaning: whichever letter was TRUE maps to "True".
        if choices["A"].strip().upper().rstrip(".").startswith("T"):
            norm = {"A": "True", "B": "False"}
        else:
            # Swap so A is always True, and remap the answer letter.
            norm = {"A": "True", "B": "False"}
            answer = "A" if answer == "B" else "B"
        choices = norm
    else:
        qtype = "multiple_choice"
        # Need at least 2 real choices for a meaningful MCQ.
        if len(choices) < 2:
            return None, f"too few MCQ choices ({len(choices)})"

    # Attach scenario context to stem for readability.
    if raw.get("scenario"):
        stem = f"[{raw['scenario']}] {stem}"

    return {
        "type": qtype,
        "question": stem,
        "choices": choices,
        "answer": answer,
    }, None


def normalize_for_dedupe(text: str) -> str:
    """
    Normalize text for duplicate detection.

    This is intentionally stricter than display cleanup but still conservative:
    we collapse formatting noise, punctuation, and comma-separated numbers so
    repeated questions copied across decks or lightly mangled by PDF extraction
    collapse to the same key.
    """
    text = clean_text(text).casefold()
    text = text.replace("&", " and ")
    text = text.replace(",", "")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def make_dedupe_key(record: dict) -> tuple[str, tuple[tuple[str, str], ...], str]:
    """Build a normalized identity for a validated record."""
    norm_choices = tuple(
        (letter, normalize_for_dedupe(text))
        for letter, text in sorted(record["choices"].items())
    )
    return (
        normalize_for_dedupe(record["question"]),
        norm_choices,
        record["answer"],
    )


# -------- main pipeline --------


def main() -> int:
    if not QUESTIONS_DIR.is_dir():
        print(f"ERROR: {QUESTIONS_DIR} not found", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    all_records: list[dict] = []
    per_source_counts: Counter = Counter()
    skip_log: list[str] = []
    per_source_seen: Counter = Counter()
    per_source_id_counter: dict[str, int] = {}
    seen_dedupe_keys: dict[
        tuple[str, tuple[tuple[str, str], ...], str], tuple[str, int | None, str]
    ] = {}
    duplicate_skips = 0

    files_on_disk = {p.name for p in QUESTIONS_DIR.glob("*.pdf")}
    processed_files: list[str] = []

    for filename in PROCESS_ORDER:
        if filename not in files_on_disk:
            continue
        if filename in processed_files:
            continue
        processed_files.append(filename)

        source, topic, prefix = FILE_MAP[filename]
        path = QUESTIONS_DIR / filename
        text = load_pdf_text(path)
        raw_questions, _ = parse_questions(text)
        per_source_seen[source] += len(raw_questions)

        # Pre-pass: find which scenario blocks reference a missing scenario.
        bad_blocks: set[int] = set()
        for raw in raw_questions:
            block = raw.get("scenario_block")
            if block is None:
                continue
            if is_placeholder_scenario(raw.get("scenario")):
                bad_blocks.add(block)

        # Count how many questions we're dropping per bad block for reporting.
        missing_ctx_counts: Counter = Counter()

        for raw in raw_questions:
            block = raw.get("scenario_block")
            if block is not None and block in bad_blocks:
                missing_ctx_counts[block] += 1
                skip_log.append(
                    f"[{filename} Q{raw.get('number')}] references a scenario "
                    f"that is not present in the PDF"
                )
                continue

            validated, reason = classify_and_validate(raw)
            if validated is None:
                skip_log.append(f"[{filename} Q{raw.get('number')}] {reason}")
                continue

            dedupe_key = make_dedupe_key(validated)
            first_seen = seen_dedupe_keys.get(dedupe_key)
            if first_seen is not None:
                first_file, first_qnum, first_source = first_seen
                duplicate_skips += 1
                skip_log.append(
                    f"[{filename} Q{raw.get('number')}] duplicate of "
                    f"[{first_file} Q{first_qnum}] from {first_source}"
                )
                continue

            per_source_id_counter.setdefault(prefix, 0)
            per_source_id_counter[prefix] += 1
            qid = f"{prefix}-{per_source_id_counter[prefix]:03d}"

            # Group id: stable per scenario block so these questions can be
            # kept together during shuffling. Ungrouped questions get null.
            group = f"{prefix}-grp-{block}" if block is not None else None

            record = {
                "id": qid,
                "source": source,
                "topic": topic,
                "type": validated["type"],
                "question": validated["question"],
                "choices": validated["choices"],
                "answer": validated["answer"],
                "group": group,
            }
            all_records.append(record)
            per_source_counts[source] += 1
            seen_dedupe_keys[dedupe_key] = (filename, raw.get("number"), source)

        for block, n in missing_ctx_counts.items():
            skip_log.append(
                f"[{filename}] dropped scenario block #{block}: "
                f"{n} questions missing scenario text"
            )

    # Warn about any PDF present on disk that wasn't in PROCESS_ORDER.
    unknown = sorted(files_on_disk - set(PROCESS_ORDER))
    if unknown:
        for u in unknown:
            skip_log.append(f"[{u}] file not in source map, skipped")

    # Final uniqueness check.
    ids_seen = [r["id"] for r in all_records]
    if len(ids_seen) != len(set(ids_seen)):
        print("ERROR: duplicate ids generated", file=sys.stderr)
        return 2

    OUT_FILE.write_text(
        json.dumps(all_records, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    total_seen = sum(per_source_seen.values())
    total_kept = len(all_records)
    total_skipped = total_seen - total_kept + sum(
        1 for s in skip_log if "file not in source map" not in s
    ) * 0  # skip_log counts already reflect skipped items; keep math simple.

    missing_ctx_skips = sum(
        1 for e in skip_log if "references a scenario that is not present" in e
    )

    group_counts: Counter = Counter()
    for r in all_records:
        if r.get("group"):
            group_counts[r["group"]] += 1

    print("=" * 60)
    print("EXTRACTION SUMMARY")
    print("=" * 60)
    print(f"Files processed     : {len(processed_files)}")
    for f in processed_files:
        print(f"  - {f}")
    print(f"Total questions seen: {total_seen}")
    print(f"Total kept (valid)  : {total_kept}")
    print(f"Total skipped       : {total_seen - total_kept}")
    if duplicate_skips:
        print(f"Skipped duplicates  : {duplicate_skips}")
    if missing_ctx_skips:
        print(
            f"Skipped {missing_ctx_skips} questions due to missing "
            f"scenario context"
        )
    print()
    print("Per-source kept counts:")
    for src in ("Lecture 7 & 8", "Lecture 9 & 10", "Lecture 11 & 12", "Extra"):
        print(f"  {src:<20} {per_source_counts.get(src, 0)}")
    print()
    if group_counts:
        print("Scenario groups (kept together when shuffling):")
        for g, n in group_counts.items():
            print(f"  {g:<18} {n} questions")
        print()
    if skip_log:
        print("Skipped items:")
        for entry in skip_log:
            print(f"  - {entry}")
    else:
        print("Skipped items: none")
    print()
    print(f"Wrote {OUT_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
