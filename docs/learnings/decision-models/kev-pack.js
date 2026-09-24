// Packing and readout for Kev's single-sequence decision format.
//
// Kev is not a generator. One state and any number of typed questions are packed into one
// sequence, and the readout is a comparison between hidden states at particular tokens. This
// module is pure: it takes a tokenize function and the delimiter ids as data, so the index
// arithmetic can be checked without loading a model.

/** Caller text can never produce a delimiter: <|name|> becomes <¦name¦> before tokenizing. */
export const escapeUserText = (text) => String(text).replace(/<\|([A-Za-z0-9_]+)\|>/g, "<\u00a6$1\u00a6>");

/** The five delimiter ids. From the model's own config.json under `kev.delimiter_ids`. */
export const DELIMITER_KEYS = ["state", "question", "option_start", "option_end", "decide"];

/**
 * Read and check the delimiter ids published with the model.
 *
 * These must not be obtained by tokenizing the delimiter strings. `<|fim_prefix|>` and its four
 * siblings tokenize to one ordinary token when passed through the caller-text escape, and a
 * graph given four copies of that token finds no option spans at all: it returns a vector of
 * zeros rather than raising, and every question then reads as a uniform distribution.
 */
export function readDelimiterIds(kevConfig) {
  const ids = kevConfig && kevConfig.delimiter_ids;
  if (!ids || typeof ids !== "object")
    throw new Error(
      "This model's config.json has no kev.delimiter_ids, so the packed decision format cannot be built. " +
        "Use a checkpoint that publishes delimiter_ids, or add them to the config beside the delimiters.",
    );
  for (const key of DELIMITER_KEYS)
    if (!Number.isInteger(ids[key]))
      throw new Error(`kev.delimiter_ids.${key} is missing or not an integer; all five delimiters are required.`);
  if (new Set(DELIMITER_KEYS.map((k) => ids[k])).size !== DELIMITER_KEYS.length)
    throw new Error("kev.delimiter_ids are not distinct; the five delimiters must be five different tokens.");
  return ids;
}

/**
 * Build one sequence carrying the state and every question.
 *
 * Layout: state, then one branch per question. A branch is the question token, the instruction
 * text, then each option wrapped in option_start/option_end, then the decide token. The graph
 * derives the segments, positions and block-causal mask from the delimiter ids itself, so the
 * block-causal rule — each question sees the state and its own branch but not the others — is
 * not something the caller implements here. All the caller supplies is ids and a mask of ones.
 *
 * @returns {{inputIds: number[], ends: number[][], questionSpans: Array<[number, number]>}}
 *   `ends[q][o]` is the index in inputIds of the token scored for option o of question q.
 */
export function packDecision({ ids, tokenize, state, questions }) {
  if (!ids || !tokenize) throw new Error("packDecision needs delimiter ids and a tokenize function.");
  if (typeof state !== "string" || !state.trim()) throw new Error("The state must be non-empty text.");
  if (!questions.length) throw new Error("At least one question is required.");
  for (const key of DELIMITER_KEYS) if (!Number.isInteger(ids[key])) throw new Error(`Delimiter id ${key} is missing.`);

  const inputIds = [ids.state, ...tokenize(state)];
  const ends = [];
  const questionSpans = [];

  for (const q of questions) {
    const instruction = tokenize(q.instruction);
    if (!instruction.length) throw new Error("A question instruction must be non-empty text.");
    if (!q.options || q.options.length < 2)
      throw new Error("A question needs at least two options, or there is nothing to choose between.");
    const spans = q.options.map((option) => [ids.option_start, ...tokenize(option), ids.option_end]);

    const base = inputIds.length;
    const questionAt = base;
    // Within the branch: the question token, then the instruction, then the option spans.
    let cursor = 1 + instruction.length;
    const branchEnds = spans.map((span) => {
      cursor += span.length;
      return base + cursor - 1; // the option_end token is the last token of each span
    });

    inputIds.push(ids.question, ...instruction, ...spans.flat(), ids.decide);
    questionSpans.push([questionAt, inputIds.length - 1]);
    ends.push(branchEnds);
  }

  for (const [q, branchEnds] of ends.entries())
    for (const index of branchEnds)
      if (!(index > 0 && index < inputIds.length))
        throw new Error(`Option score position ${index} for question ${q} falls outside the sequence.`);

  return { inputIds, ends, questionSpans };
}

/** Softmax, subtracting the maximum so large scores cannot overflow to Infinity. */
export function softmax(values) {
  if (!values.length) throw new Error("softmax needs at least one value.");
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("softmax produced no usable total.");
  return exps.map((e) => e / total);
}

/**
 * Turn the score at each option's final token into a distribution per question.
 *
 * The graph returns one score per token. Only the positions in `ends` matter; softmax is taken
 * within a question, never across questions.
 */
export function readAnswers({ scores, ends }) {
  return ends.map((branchEnds) => softmax(branchEnds.map((index) => scores[index])));
}

/** Choice: the option with the highest probability. Ties keep the earlier option. */
export function choose(distribution) {
  let best = 0;
  for (let i = 1; i < distribution.length; i++) if (distribution[i] > distribution[best]) best = i;
  return best;
}

/** Noul: p(second option), where options are ["no", "yes"]. */
export const NOUL_OPTIONS = ["no", "yes"];
export const noulProbability = (distribution) => distribution[1];

/** Score: the expected level over an ordered scale, which may be fractional. */
export function expectedLevel(distribution) {
  return distribution.reduce((sum, p, level) => sum + p * level, 0);
}

/**
 * A verdict for the published examples, and only that.
 *
 * Naming this a "threshold policy" rather than a calibrated probability is not hedging. On
 * question shapes unlike its training data this model ranks cases correctly while returning
 * probabilities well below the midpoint — a real credential-grab scored 0.142 and a harmless
 * message 0.055 on the same instruction. Both below 0.5, so a midpoint threshold answers "no"
 * to both and the correct ranking is thrown away. Judge the ranking first; move the threshold
 * only against labelled data.
 */
export function verdict(probability, threshold = 0.5) {
  if (!(threshold > 0 && threshold < 1)) throw new Error("The threshold must lie between 0 and 1.");
  if (probability >= threshold) return "yes";
  if (probability <= 1 - threshold) return "no";
  return "unclear";
}
