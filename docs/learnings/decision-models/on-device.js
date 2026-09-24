// Run Kev on this machine, in this tab. No decision request leaves the browser.
//
// The only network traffic is the model download from huggingface.co. The runtime is vendored
// from this origin, so no third-party script is executed.
import { AutoTokenizer, PreTrainedModel, Tensor, env } from "../vendor/transformers.web.min.js";
import {
  escapeUserText,
  readDelimiterIds,
  packDecision,
  readAnswers,
  choose,
  expectedLevel,
  noulProbability,
  verdict,
  NOUL_OPTIONS,
} from "./kev-pack.js";

const REPO = "onnx-community/kev-0.6b-ONNX";
// q4 keeps the whole graph in 4-bit weights with the pointer head in fp32. The q4f16 variant is
// aimed at WebGPU, which this site does not vendor.
const DTYPE = "q4";
const DEVICE = "wasm";

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const line = (text, cls) => $("log").append(el("p", text, cls));

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/", import.meta.url).href;

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

let session = null; // { tokenizer, model, ids, cache }

const downloaded = new Map();
function progress(event) {
  if (!event || event.status !== "progress" || !event.file) return;
  downloaded.set(event.file, { loaded: event.loaded || 0, total: event.total || 0 });
  let loaded = 0;
  let total = 0;
  for (const f of downloaded.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  const mb = (n) => (n / 1048576).toFixed(1);
  $("progress").textContent = total
    ? `${mb(loaded)} MB of ${mb(total)} MB · ${downloaded.size} file${downloaded.size === 1 ? "" : "s"} · ${event.file}`
    : `contacting ${event.file}`;
}

async function load() {
  $("load").disabled = true;
  $("load-state").textContent = "Loading the runtime, then the weights…";
  const started = performance.now();
  try {
    const tokenizer = await AutoTokenizer.from_pretrained(REPO, { progress_callback: progress });
    const model = await PreTrainedModel.from_pretrained(REPO, {
      dtype: DTYPE,
      device: DEVICE,
      progress_callback: progress,
    });
    const ids = readDelimiterIds(model.config?.kev);
    session = { tokenizer, model, ids, cache: new Map() };
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    $("progress").textContent = `Ready in ${seconds}s.`;
    $("load-state").textContent = "Model loaded. Nothing has been sent anywhere.";
    describeBackend();
    $("workbench").hidden = false;
    await runExercises();
  } catch (error) {
    $("load-state").textContent = `Could not load the model: ${error.message}`;
    line(String(error.stack || error), "bad");
    $("load").disabled = false;
  }
}

/**
 * Report what actually ran, rather than what was asked for.
 *
 * A WebGPU request can quietly fall back to WebAssembly, and a claim about the backend is a
 * claim about which code executed. This reads the session's execution providers and says so.
 */
function describeBackend() {
  const providers = [];
  const sessions = session.model?.model?.sessions || session.model?.sessions || [];
  for (const s of sessions) {
    const eps = s?.session?.executionProviders || s?.executionProviders;
    if (eps) providers.push(...eps);
  }
  const gpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const isolated = typeof crossOriginIsolated === "boolean" && crossOriginIsolated;
  $("backend").textContent =
    `Requested ${DEVICE}. ` +
    (providers.length ? `Session reports: ${[...new Set(providers)].join(", ")}. ` : "Session did not report its providers. ") +
    `WebGPU is ${gpu ? "present in this browser" : "not present in this browser"} and this site does not vendor the 27 MB WebGPU binary, so it was not used. ` +
    `Cross-origin isolation is ${isolated ? "on, so threaded wasm may be available" : "off, so wasm runs without shared-memory threads"}.`;
}

// ---------------------------------------------------------------------------------------------
// Tokenising and one forward pass
// ---------------------------------------------------------------------------------------------

/** Tokenise every distinct string once, so packing can stay synchronous. */
async function tokenize(text) {
  const escaped = escapeUserText(text);
  if (!session.cache.has(escaped)) {
    const encoded = await session.tokenizer(escaped, { add_special_tokens: false });
    session.cache.set(escaped, Array.from(encoded.input_ids.data, Number));
  }
  return session.cache.get(escaped);
}

const lookUp = (text) => {
  const tokens = session.cache.get(escapeUserText(text));
  if (!tokens) throw new Error(`"${text}" was not tokenised before packing.`);
  return tokens;
};

async function decide(state, questions) {
  const texts = [state];
  for (const q of questions) texts.push(q.instruction, ...q.options);
  for (const text of texts) await tokenize(text);

  const { inputIds, ends } = packDecision({
    ids: session.ids,
    tokenize: lookUp,
    state,
    questions,
  });

  const started = performance.now();
  const { logits } = await session.model({
    input_ids: new Tensor("int64", BigInt64Array.from(inputIds, BigInt), [1, inputIds.length]),
    attention_mask: new Tensor("int64", new BigInt64Array(inputIds.length).fill(1n), [1, inputIds.length]),
  });
  const scores = Array.from(logits.to("float32").data);
  const ms = performance.now() - started;

  // A graph that found no delimiters returns zeros rather than raising, and every question then
  // reads as a uniform distribution. Say that rather than presenting it as a confident tie.
  const flat = new Set(scores.map((v) => v.toFixed(6))).size === 1;

  return { distributions: readAnswers({ scores, ends }), tokens: inputIds.length, ms, flat };
}

// ---------------------------------------------------------------------------------------------
// Exercises: cases whose right answer was known before the model ran
// ---------------------------------------------------------------------------------------------

const ROUTE = [
  "billing: Charges, refunds, invoices",
  "technical support: Bugs, outages, login problems",
  "sales: Pricing, demos, new subscriptions",
  "account management: Profile, password, settings",
];
const TICKET = "I was charged twice for the same order and nobody answers my emails. I want my money back now.";
const PHISHING = "Please confirm your password and reply with the full number on the front of your card.";
const CREDENTIAL_QUESTION = "Is the sender trying to get the reader's password or card number?";

const EXERCISES = [
  {
    name: "A ticket about a double charge",
    kind: "choice",
    state: TICKET,
    question: { instruction: "Which team should handle this ticket?", options: ROUTE },
    expect: ROUTE[0],
  },
  {
    name: "The same ticket, options in reverse order",
    kind: "choice",
    note: "The answer must follow the label, not the position. If it moves to the last option, the readout is indexing tokens wrongly.",
    state: TICKET,
    question: { instruction: "Which team should handle this ticket?", options: [...ROUTE].reverse() },
    expect: ROUTE[0],
  },
  {
    name: "A login problem",
    kind: "choice",
    state: "I cannot log in to my account since the update, and the password reset email never arrives.",
    question: { instruction: "Which team should handle this ticket?", options: ROUTE },
    expect: ROUTE[1],
  },
  {
    name: "Was a refund asked for? Yes.",
    kind: "noul",
    state: TICKET,
    question: { instruction: "Is the customer asking for a refund?", options: NOUL_OPTIONS },
    expect: "yes",
  },
  {
    name: "Was a refund asked for? No.",
    kind: "noul",
    note: "The negative case. A model that answers yes to everything passes the line above and fails this one.",
    state: "Thanks, the replacement arrived this morning and it works perfectly.",
    question: { instruction: "Is the customer asking for a refund?", options: NOUL_OPTIONS },
    expect: "no",
  },
  {
    name: "Does this need attention within the hour? An outage.",
    kind: "noul",
    state: "Our checkout has been returning errors for every customer since 09:00 and we are losing sales by the minute.",
    question: { instruction: "Does this need attention within the hour?", options: NOUL_OPTIONS },
    expect: "yes",
  },
  {
    name: "Does this need attention within the hour? A shade of grey.",
    kind: "noul",
    state: "The footer logo is a slightly different shade of grey than the header on our about page.",
    question: { instruction: "Does this need attention within the hour?", options: NOUL_OPTIONS },
    expect: "no",
  },
  {
    name: "Is this message trying to get a password or card number?",
    kind: "noul",
    note: "The one this model gets wrong. See the finding below.",
    state: PHISHING,
    question: { instruction: CREDENTIAL_QUESTION, options: NOUL_OPTIONS },
    expect: "yes",
  },
  {
    name: "An angry tone",
    kind: "score",
    state: TICKET,
    question: {
      instruction: "How positive is the tone of this message?",
      options: ["very negative", "negative", "neutral", "positive", "very positive"],
    },
    expect: "below 1.5",
    check: (d) => expectedLevel(d) < 1.5,
  },
  {
    name: "A pleased tone",
    kind: "score",
    state: "Thanks, the replacement arrived this morning and it works perfectly.",
    question: {
      instruction: "How positive is the tone of this message?",
      options: ["very negative", "negative", "neutral", "positive", "very positive"],
    },
    expect: "above 2.5",
    check: (d) => expectedLevel(d) > 2.5,
  },
  {
    name: "Which tool should be called",
    kind: "choice",
    state: "A user asks: what is the weather in Manchester tomorrow?",
    question: {
      instruction: "Which tool should be called to answer this?",
      options: [
        "search_docs: search the product documentation",
        "get_forecast: fetch a weather forecast for a place and date",
        "send_email: send an email to a recipient",
        "run_sql: run a read-only query against the analytics database",
      ],
    },
    expect: "get_forecast: fetch a weather forecast for a place and date",
  },
  {
    name: "Which question the interface should ask next",
    kind: "choice",
    state: "The user has chosen a refund and confirmed the order number, but has not said why.",
    question: {
      instruction: "Which question should the interface ask next?",
      options: [
        "confirm the order number",
        "ask why the item is being returned",
        "ask for a discount code",
        "ask which payment method they used",
      ],
    },
    expect: "ask why the item is being returned",
  },
];

function bar(label, value) {
  const row = el("div", undefined, "bar");
  const meter = el("meter");
  meter.min = 0;
  meter.max = 1;
  meter.value = value;
  meter.setAttribute("aria-label", `${label} probability`);
  row.append(el("span", label), meter, el("output", (value * 100).toFixed(1) + "%"));
  return row;
}

/** Read a distribution the way the primitive it belongs to is meant to be read. */
function readout(exercise, distribution) {
  if (exercise.kind === "noul") {
    const p = noulProbability(distribution);
    return { summary: `p(yes) = ${p.toFixed(3)}`, verdict: verdict(p), pass: verdict(p) === exercise.expect };
  }
  if (exercise.kind === "score") {
    const level = expectedLevel(distribution);
    return {
      summary: `expected level ${level.toFixed(2)} of ${distribution.length - 1}`,
      verdict: `${level.toFixed(2)}`,
      pass: exercise.check(distribution),
    };
  }
  const index = choose(distribution);
  const selected = exercise.question.options[index];
  return { summary: `chose ${selected}`, verdict: selected, pass: selected === exercise.expect };
}

let passed = 0;
const latencies = [];

async function runExercises() {
  const target = $("exercises");
  target.replaceChildren();
  passed = 0;
  latencies.length = 0;

  for (const exercise of EXERCISES) {
    const result = await decide(exercise.state, [exercise.question]);
    const distribution = result.distributions[0];
    const read = readout(exercise, distribution);
    if (read.pass) passed++;
    latencies.push(result.ms);

    const box = el("section", undefined, "answer");
    box.append(el("h3", `${read.pass ? "Passes" : "Fails"} — ${exercise.name}`));
    if (exercise.note) box.append(el("p", exercise.note, "small"));
    box.append(el("p", read.summary));
    for (const [label, value] of exercise.question.options.map((o, i) => [o, distribution[i]])) box.append(bar(label, value));
    box.append(el("p", `Expected ${exercise.expect}. ${result.ms.toFixed(0)} ms, ${result.tokens} tokens.`, "small"));
    if (result.flat)
      box.append(
        el(
          "p",
          "Every score in this graph output was identical, so this distribution is a uniform tie rather than a decision. That is what a missing delimiter looks like — check the delimiter ids before reading anything into the numbers.",
          "bad",
        ),
      );
    target.append(box);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  $("summary").textContent =
    `${passed} of ${EXERCISES.length} exercises matched the expected answer. ` +
    `Latency per decision: fastest ${Math.min(...latencies).toFixed(0)} ms, median ${median.toFixed(0)} ms, slowest ${Math.max(...latencies).toFixed(0)} ms, ` +
    `measured in this tab on ${DEVICE}.`;
  $("run").disabled = false;
  $("batch").disabled = false;
  $("custom").disabled = false;
}

// ---------------------------------------------------------------------------------------------
// One call, many questions, on text the reader supplies
// ---------------------------------------------------------------------------------------------

async function runBatch() {
  $("summary").textContent = "";
  const questions = [
    { instruction: "Which team should handle this ticket?", options: ROUTE },
    { instruction: "Is the customer asking for a refund?", options: NOUL_OPTIONS },
    { instruction: "How positive is the tone of this message?", options: ["very negative", "negative", "neutral", "positive", "very positive"] },
    { instruction: "Does the customer mention a specific deadline?", options: NOUL_OPTIONS },
  ];
  const result = await decide(TICKET, questions);
  const box = el("section", undefined, "answer");
  box.append(el("h2", `${questions.length} questions, one forward pass`));
  box.append(
    el(
      "p",
      `All four questions were packed into a single ${result.tokens}-token sequence and answered in ${result.ms.toFixed(0)} ms. ` +
        `Cost does not scale with the length of an answer, because there is no answer to generate.`,
    ),
  );
  questions.forEach((q, i) => {
    box.append(el("h4", q.instruction));
    q.options.forEach((option, o) => box.append(bar(option, result.distributions[i][o])));
  });
  box.append(el("p", "Each question sees the shared state and its own branch. It does not see the other questions' answers.", "small"));
  $("exercises").replaceChildren(box);
}

async function runCustom() {
  const state = $("custom-state").value;
  const questions = JSON.parse($("custom-questions").value);
  if (!Array.isArray(questions)) throw new Error("The questions must be a JSON array.");
  $("summary").textContent = "";
  const result = await decide(state, questions);
  const box = el("section", undefined, "answer");
  box.append(el("h2", `${questions.length} questions, one forward pass`));
  questions.forEach((q, i) => {
    box.append(el("h4", q.instruction));
    const kind = q.options.length === 2 && q.options[0] === "no" ? "noul" : "choice";
    q.options.forEach((option, o) => box.append(bar(option, result.distributions[i][o])));
    const d = result.distributions[i];
    box.append(
      el(
        "p",
        kind === "noul"
          ? `Read as noul: ${verdict(noulProbability(d))}.`
          : `Read as choice: ${q.options[choose(d)]}.`,
        "small",
      ),
    );
  });
  box.append(el("p", `${result.tokens} tokens, ${result.ms.toFixed(0)} ms.`, "small"));
  $("exercises").replaceChildren(box);
}

$("load").onclick = load;
$("backend-check").onclick = () => {
  const gpu = typeof navigator !== "undefined" && "gpu" in navigator;
  $("backend-check-out").textContent =
    `navigator.gpu: ${gpu ? "present" : "absent"} · crossOriginIsolated: ${typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : "unknown"} · ` +
    `hardwareConcurrency: ${navigator.hardwareConcurrency ?? "unknown"} · deviceMemory: ${navigator.deviceMemory ?? "not reported"}`;
};
$("run").onclick = () => runExercises().catch((e) => line(String(e), "bad"));
$("batch").onclick = () => runBatch().catch((e) => line(String(e), "bad"));
$("custom").onclick = () => runCustom().catch((e) => line(String(e.message || e), "bad"));
