/**
 * Reading a memory's text without a language model: what a fact is about, and
 * which words of a question carry its meaning. PURE: no database, no device.
 */

/** Subjects that say nothing about what a fact is about. */
const GENERIC = new Set(
  "note notes todo warning lesson reminder example tip summary update result reason it this that there he she they we i".split(
    " ",
  ),
);

export interface FactSubject {
  /** What the fact is about, normalised: "wan ip". */
  subject: string;
  /** What it says about it, normalised: "203.0.113.7". */
  value: string;
  /** True when the subject is specific enough to retire an older fact on its own. */
  sure: boolean;
}

/**
 * The subject and value of a fact written as "subject: value", "subject = value"
 * or "subject is value". Null for any other text.
 *
 * A colon counts only before a space, so an address such as `10.0.0.1:8080` or a
 * URL is not split.
 */
export function factSubject(content: string): FactSubject | null {
  const line = (content.split("\n")[0] ?? "").trim();
  const match = line.match(/^(.{2,80}?)(?::\s+|\s*=\s*|\s+(?:is|are|was|were)\s+)(\S.*)$/i);
  if (!match) return null;
  const subject = match[1]!
    .toLowerCase()
    .replace(/^(?:the|a|an|our|my)\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;]+$/, "")
    .trim();
  const value = match[2]!
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.]+$/, "");
  if (subject.length < 2 || value === "" || GENERIC.has(subject)) return null;
  const words = subject.split(" ");
  return {
    subject,
    value,
    // One word ("dns") is too loose to act on: two facts about DNS can both be true.
    sure: words.length >= 2 && !GENERIC.has(words[0]!) && subject.length >= 5,
  };
}

/** Words that carry no meaning in a question. */
const STOP = new Set(
  (
    "a an the and or but if then than so of to in on at by for from with without about into over under " +
    "is are was were be been being am do does did done have has had having can could should would will " +
    "shall may might must i me my we our us you your he she it its they them their this that these those " +
    "there here what which who whom whose when where why how not no yes any all some each every both " +
    "please tell show give get find list check know want need use used using currently now right just also " +
    "many much more most less few very too same other another one two"
  ).split(" "),
);

/**
 * The words of a question that memory must hold for the question to have an
 * answer: lower case, in order, without filler words, at most 24. An address or
 * a name with dots, colons, slashes or dashes stays one word.
 */
export function questionTerms(question: string): string[] {
  const words =
    question
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}_.:/-]*/gu) ?? [];
  const terms = words
    .map((word) => word.replace(/[.:/-]+$/, ""))
    .filter((word) => word.length >= 2 && !STOP.has(word));
  return [...new Set(terms)].slice(0, 24);
}
