"use strict";

const DECKS = [
  { key: "L78", label: "Lecture 7 & 8", match: (q) => q.source === "Lecture 7 & 8" },
  { key: "L910", label: "Lecture 9 & 10", match: (q) => q.source === "Lecture 9 & 10" },
  { key: "L1112", label: "Lecture 11 & 12", match: (q) => q.source === "Lecture 11 & 12" },
  { key: "EXT", label: "Extra", match: (q) => q.source === "Extra" },
  { key: "ALL", label: "All Randomized", match: () => true },
];

const STORAGE_KEY = "cen800.quiz.state.v1";
const STORAGE_VERSION = 1;

const els = {
  landing: document.getElementById("view-landing"),
  quiz: document.getElementById("view-quiz"),
  results: document.getElementById("view-results"),
  sessionInfo: document.getElementById("session-info"),
  deckLabel: document.getElementById("deck-label"),
  progress: document.getElementById("progress"),
  score: document.getElementById("score"),
  deckPicker: document.getElementById("deck-picker"),
  startBtn: document.getElementById("start-btn"),
  bankStatus: document.getElementById("bank-status"),
  scenario: document.getElementById("scenario"),
  questionText: document.getElementById("question-text"),
  choices: document.getElementById("choices"),
  feedback: document.getElementById("feedback"),
  nextBtn: document.getElementById("next-btn"),
  quitBtn: document.getElementById("quit-btn"),
  resultsSummary: document.getElementById("results-summary"),
  retryMissedBtn: document.getElementById("retry-missed-btn"),
  restartBtn: document.getElementById("restart-btn"),
  homeBtn: document.getElementById("home-btn"),
  reviewList: document.getElementById("review-list"),
};

const state = {
  bank: [],
  selectedDeck: null,
  session: null,
};

/* ---------- persistence ---------- */

function persistState() {
  try {
    const payload = {
      version: STORAGE_VERSION,
      selectedDeckKey: state.selectedDeck ? state.selectedDeck.key : null,
      session: state.session
        ? {
            label: state.session.label,
            queue: state.session.queue,
            index: state.session.index,
            correct: state.session.correct,
            answered: state.session.answered,
          }
        : null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Failed to persist quiz progress.", err);
  }
}

function clearPersistedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("Failed to clear saved quiz progress.", err);
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isQuestionShape(q) {
  return (
    q &&
    typeof q === "object" &&
    typeof q.question === "string" &&
    q.choices &&
    typeof q.choices === "object" &&
    typeof q.answer === "string"
  );
}

function deserializeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.queue) || raw.queue.some((q) => !isQuestionShape(q))) {
    return null;
  }
  if (!Array.isArray(raw.answered)) return null;
  if (raw.queue.length === 0) return null;

  const index = Number.isInteger(raw.index) ? raw.index : 0;
  const correct = Number.isInteger(raw.correct) ? raw.correct : 0;

  const boundedIndex = Math.max(0, Math.min(index, raw.queue.length - 1));
  const boundedCorrect = Math.max(0, Math.min(correct, raw.queue.length));
  const answered = raw.answered.filter(
    (a) =>
      a &&
      typeof a === "object" &&
      typeof a.chosen === "string" &&
      typeof a.correct === "boolean" &&
      isQuestionShape(a.question)
  );

  return {
    label: typeof raw.label === "string" ? raw.label : "Quiz",
    queue: raw.queue,
    index: boundedIndex,
    correct: boundedCorrect,
    answered: answered.slice(0, raw.queue.length),
    answeredCurrent: false,
  };
}

function restorePersistedState() {
  let payload;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessionRestored: false, deckRestored: false };
    payload = JSON.parse(raw);
  } catch (err) {
    clearPersistedState();
    return { sessionRestored: false, deckRestored: false };
  }

  if (!payload || payload.version !== STORAGE_VERSION) {
    clearPersistedState();
    return { sessionRestored: false, deckRestored: false };
  }

  let deckRestored = false;
  if (typeof payload.selectedDeckKey === "string") {
    const deck = DECKS.find((d) => d.key === payload.selectedDeckKey) || null;
    if (deck) {
      state.selectedDeck = deck;
      deckRestored = true;
    }
  }

  const session = deserializeSession(payload.session);
  if (!session) {
    applySelectedDeckUI();
    return { sessionRestored: false, deckRestored };
  }

  startSession(session, { suppressSave: true });
  if (session.answered.length >= session.queue.length) {
    showResults({ suppressSave: true });
  }
  return { sessionRestored: true, deckRestored };
}

/* ---------- data loading ---------- */

async function loadBank() {
  const res = await fetch("../data/question_bank.json", { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Shuffle questions while keeping scenario-grouped questions together.
 *
 * Each question has an optional `group` id. Questions with the same group id
 * belong to a shared scenario and must stay in their original consecutive
 * order. Ungrouped questions are treated as singletons. Groups (and
 * singletons) are then shuffled against each other.
 */
function shuffleWithGroups(questions) {
  const groups = new Map();
  const singletons = [];
  for (const q of questions) {
    if (q.group) {
      if (!groups.has(q.group)) groups.set(q.group, []);
      groups.get(q.group).push(q);
    } else {
      singletons.push([q]);
    }
  }
  // Sort each group by id so the intended consecutive order is preserved.
  const grouped = Array.from(groups.values()).map((list) =>
    list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );
  const units = shuffle(grouped.concat(singletons));
  return units.flat();
}

/* ---------- deck picker ---------- */

function renderDeckPicker() {
  els.deckPicker.innerHTML = "";
  for (const deck of DECKS) {
    const count = state.bank.filter(deck.match).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "deck-option";
    btn.dataset.key = deck.key;
    btn.disabled = count === 0;
    btn.innerHTML =
      `<span>${deck.label}</span><span class="count">${count} Qs</span>`;
    btn.addEventListener("click", () => {
      state.selectedDeck = deck;
      applySelectedDeckUI();
      persistState();
    });
    els.deckPicker.appendChild(btn);
  }
  applySelectedDeckUI();
}

function applySelectedDeckUI() {
  document
    .querySelectorAll(".deck-option")
    .forEach((el) => el.classList.remove("selected"));
  if (!state.selectedDeck) {
    els.startBtn.disabled = true;
    return;
  }
  const selectedBtn = document.querySelector(
    `.deck-option[data-key="${state.selectedDeck.key}"]`
  );
  if (!selectedBtn || selectedBtn.disabled) {
    state.selectedDeck = null;
    els.startBtn.disabled = true;
    return;
  }
  selectedBtn.classList.add("selected");
  els.startBtn.disabled = false;
}

/* ---------- session ---------- */

function buildSessionFromDeck(deck) {
  const pool = state.bank.filter(deck.match);
  return buildSession(pool, deck.label);
}

function buildSession(pool, label, { keepGroups = true } = {}) {
  return {
    label,
    queue: keepGroups ? shuffleWithGroups(pool) : shuffle(pool),
    index: 0,
    correct: 0,
    answered: [],
    answeredCurrent: false,
  };
}

function startSession(session, { suppressSave = false } = {}) {
  state.session = session;
  els.landing.hidden = true;
  els.results.hidden = true;
  els.quiz.hidden = false;
  els.sessionInfo.hidden = false;
  els.deckLabel.textContent = session.label;
  renderCurrentQuestion();
  if (!suppressSave) persistState();
}

function renderCurrentQuestion() {
  const s = state.session;
  const q = s.queue[s.index];
  s.answeredCurrent = s.answered.length > s.index;

  els.progress.textContent = `Q ${s.index + 1} / ${s.queue.length}`;
  els.score.textContent = `Score: ${s.correct}`;

  // Split off optional "[scenario] stem" prefix for display.
  const { scenario, stem } = splitScenario(q.question);
  if (scenario) {
    els.scenario.hidden = false;
    els.scenario.textContent = scenario;
  } else {
    els.scenario.hidden = true;
    els.scenario.textContent = "";
  }
  els.questionText.textContent = stem;

  els.choices.innerHTML = "";
  for (const letter of Object.keys(q.choices)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.dataset.letter = letter;
    btn.innerHTML =
      `<span class="letter">${letter}.</span>` +
      `<span class="text"></span>`;
    btn.querySelector(".text").textContent = q.choices[letter];
    btn.addEventListener("click", () => handleAnswer(letter));
    els.choices.appendChild(btn);
  }

  els.feedback.hidden = true;
  els.feedback.className = "feedback";
  els.feedback.textContent = "";
  els.nextBtn.disabled = !s.answeredCurrent;
  els.nextBtn.textContent =
    s.index === s.queue.length - 1 ? "Finish" : "Next";

  if (s.answeredCurrent) {
    renderSavedAnswerState();
  }
}

function splitScenario(text) {
  if (text.startsWith("[")) {
    const end = text.indexOf("] ");
    if (end !== -1) {
      return { scenario: text.slice(1, end), stem: text.slice(end + 2) };
    }
  }
  return { scenario: null, stem: text };
}

function handleAnswer(letter) {
  const s = state.session;
  if (s.answeredCurrent) return;
  s.answeredCurrent = true;

  const q = s.queue[s.index];
  const correctLetter = q.answer;
  const isCorrect = letter === correctLetter;
  if (isCorrect) s.correct++;

  s.answered.push({
    question: q,
    chosen: letter,
    correct: isCorrect,
  });

  // Highlight choices.
  const buttons = els.choices.querySelectorAll(".choice");
  buttons.forEach((b) => {
    b.disabled = true;
    const bLetter = b.dataset.letter;
    if (bLetter === correctLetter) b.classList.add("correct");
    else if (bLetter === letter) b.classList.add("incorrect");
  });

  // Feedback banner.
  els.feedback.hidden = false;
  if (isCorrect) {
    els.feedback.classList.add("ok");
    els.feedback.textContent = "Correct.";
  } else {
    els.feedback.classList.add("bad");
    els.feedback.textContent =
      `Incorrect. Correct answer: ${correctLetter}. ${q.choices[correctLetter]}`;
  }

  els.score.textContent = `Score: ${s.correct}`;
  els.nextBtn.disabled = false;
  persistState();
}

function nextOrFinish() {
  const s = state.session;
  if (s.index < s.queue.length - 1) {
    s.index++;
    renderCurrentQuestion();
    persistState();
  } else {
    showResults();
  }
}

function showResults({ suppressSave = false } = {}) {
  const s = state.session;
  els.quiz.hidden = true;
  els.results.hidden = false;

  const pct = s.queue.length === 0
    ? 0
    : Math.round((s.correct / s.queue.length) * 100);
  els.resultsSummary.textContent =
    `You scored ${s.correct} / ${s.queue.length} (${pct}%).`;

  const missed = s.answered.filter((a) => !a.correct);
  els.retryMissedBtn.disabled = missed.length === 0;
  els.retryMissedBtn.textContent = missed.length
    ? `Retry ${missed.length} missed question${missed.length === 1 ? "" : "s"}`
    : "No missed questions";

  els.reviewList.innerHTML = "";
  s.answered.forEach((a, i) => {
    const li = document.createElement("li");
    const ok = a.correct;
    const { stem } = splitScenario(a.question.question);
    const chosenTxt = a.question.choices[a.chosen] || "(no answer)";
    const correctTxt = a.question.choices[a.question.answer];
    li.innerHTML =
      `<div class="review-q">${i + 1}. ${escapeHtml(stem)}</div>` +
      (ok
        ? `<div class="review-correct">Your answer: ${a.chosen}. ${escapeHtml(chosenTxt)}</div>`
        : `<div class="review-incorrect">Your answer: ${a.chosen}. ${escapeHtml(chosenTxt)}</div>` +
          `<div class="review-correct">Correct: ${a.question.answer}. ${escapeHtml(correctTxt)}</div>`);
    els.reviewList.appendChild(li);
  });
  if (!suppressSave) persistState();
}

function renderSavedAnswerState() {
  const s = state.session;
  const q = s.queue[s.index];
  const saved = s.answered[s.index];
  if (!saved || typeof saved.chosen !== "string") {
    s.answeredCurrent = false;
    els.nextBtn.disabled = true;
    return;
  }

  const chosen = saved.chosen;
  const correctLetter = q.answer;
  const isCorrect = chosen === correctLetter;

  const buttons = els.choices.querySelectorAll(".choice");
  buttons.forEach((b) => {
    b.disabled = true;
    const bLetter = b.dataset.letter;
    if (bLetter === correctLetter) b.classList.add("correct");
    else if (bLetter === chosen) b.classList.add("incorrect");
  });

  els.feedback.hidden = false;
  if (isCorrect) {
    els.feedback.classList.add("ok");
    els.feedback.textContent = "Correct.";
  } else {
    const answerText = hasOwn(q.choices, correctLetter)
      ? q.choices[correctLetter]
      : "(answer missing)";
    els.feedback.classList.add("bad");
    els.feedback.textContent =
      `Incorrect. Correct answer: ${correctLetter}. ${answerText}`;
  }
  els.nextBtn.disabled = false;
}

function goHome() {
  state.session = null;
  state.selectedDeck = null;
  els.quiz.hidden = true;
  els.results.hidden = true;
  els.sessionInfo.hidden = true;
  els.landing.hidden = false;
  els.startBtn.disabled = true;
  document
    .querySelectorAll(".deck-option")
    .forEach((el) => el.classList.remove("selected"));
  persistState();
}

function retryMissed() {
  const s = state.session;
  const missed = s.answered.filter((a) => !a.correct).map((a) => a.question);
  if (!missed.length) return;
  // For missed-only retry we allow plain shuffling since the group may be
  // incomplete (user may only have missed some of a scenario's questions).
  startSession(buildSession(missed, `${s.label} (missed)`, { keepGroups: false }));
}

function restartSameDeck() {
  const s = state.session;
  // Rebuild from the original pool by using all unique questions in the deck.
  const deck = state.selectedDeck;
  if (deck) startSession(buildSessionFromDeck(deck));
  else startSession(buildSession(s.queue, s.label));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- wire up ---------- */

els.startBtn.addEventListener("click", () => {
  if (!state.selectedDeck) return;
  startSession(buildSessionFromDeck(state.selectedDeck));
});

els.nextBtn.addEventListener("click", nextOrFinish);
els.quitBtn.addEventListener("click", () => {
  if (confirm("Quit and see results so far?")) showResults();
});
els.retryMissedBtn.addEventListener("click", retryMissed);
els.restartBtn.addEventListener("click", restartSameDeck);
els.homeBtn.addEventListener("click", goHome);

(async function init() {
  try {
    state.bank = await loadBank();
    if (!Array.isArray(state.bank) || state.bank.length === 0) {
      els.bankStatus.textContent =
        "No questions found. Run the extraction script first (see README).";
      return;
    }
    renderDeckPicker();
    const restored = restorePersistedState();
    if (restored.sessionRestored) {
      els.bankStatus.textContent =
        `Loaded ${state.bank.length} questions. Restored saved progress.`;
    } else if (restored.deckRestored) {
      els.bankStatus.textContent =
        `Loaded ${state.bank.length} questions. Restored deck selection.`;
    } else {
      els.bankStatus.textContent = `Loaded ${state.bank.length} questions.`;
    }
  } catch (err) {
    els.bankStatus.textContent =
      "Failed to load questions. Make sure you started the local server from the project root (see README).";
    console.error(err);
  }
})();
