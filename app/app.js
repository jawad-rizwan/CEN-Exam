"use strict";

const DECKS = [
  { key: "L78", label: "Lecture 7 & 8", match: (q) => q.source === "Lecture 7 & 8" },
  { key: "L910", label: "Lecture 9 & 10", match: (q) => q.source === "Lecture 9 & 10" },
  { key: "L1112", label: "Lecture 11 & 12", match: (q) => q.source === "Lecture 11 & 12" },
  { key: "EXT", label: "Extra", match: (q) => q.source === "Extra" },
  { key: "ALL", label: "All Randomized", match: () => true },
];

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
      document
        .querySelectorAll(".deck-option")
        .forEach((el) => el.classList.remove("selected"));
      btn.classList.add("selected");
      els.startBtn.disabled = false;
    });
    els.deckPicker.appendChild(btn);
  }
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

function startSession(session) {
  state.session = session;
  els.landing.hidden = true;
  els.results.hidden = true;
  els.quiz.hidden = false;
  els.sessionInfo.hidden = false;
  els.deckLabel.textContent = session.label;
  renderCurrentQuestion();
}

function renderCurrentQuestion() {
  const s = state.session;
  const q = s.queue[s.index];
  s.answeredCurrent = false;

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
  els.nextBtn.disabled = true;
  els.nextBtn.textContent =
    s.index === s.queue.length - 1 ? "Finish" : "Next";
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
}

function nextOrFinish() {
  const s = state.session;
  if (s.index < s.queue.length - 1) {
    s.index++;
    renderCurrentQuestion();
  } else {
    showResults();
  }
}

function showResults() {
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
    els.bankStatus.textContent = `Loaded ${state.bank.length} questions.`;
    renderDeckPicker();
  } catch (err) {
    els.bankStatus.textContent =
      "Failed to load questions. Make sure you started the local server from the project root (see README).";
    console.error(err);
  }
})();
