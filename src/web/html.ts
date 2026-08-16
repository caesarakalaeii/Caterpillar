/**
 * HTML assembly that escapes by default. See DESIGN.md §18.
 *
 * Every interesting string on these pages is AGENT-AUTHORED or quoted by an agent from a
 * repository it read: a goal, a journal entry, a question, the text of a bash result. The
 * §11.2 rule about Discord mentions is the same rule as this one, one layer down — prose
 * from a model is untrusted input, and a template that interpolates it raw turns a
 * repository's README into script running on the origin that serves the transcripts.
 *
 * So the default is escaped and `raw` is the one visible exception, rather than the other
 * way round. There is no sanitiser here and there should never be one: sanitising is a
 * guessing game, escaping is not.
 */

/** A fragment that is already HTML. The only thing interpolated without escaping. */
export interface Html {
  readonly __html: string;
}

export const raw = (value: string): Html => ({ __html: value });

export const render = (fragment: Html): string => fragment.__html;

const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && typeof (value as Html).__html === "string";

/**
 * `&` first, or the escapes escape each other. `'` as `&#39;` rather than `&apos;`,
 * which is not defined in HTML 4 and is a real difference in old parsers.
 */
export const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const interpolate = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (isHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escape(String(value));
};

export const html = (strings: TemplateStringsArray, ...values: readonly unknown[]): Html => {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]) + (strings[i + 1] ?? "");
  }
  return raw(out);
};

export const join = (fragments: readonly Html[], separator: Html): Html =>
  raw(fragments.map((fragment) => fragment.__html).join(separator.__html));

/**
 * A URL safe to put in an `href`, or nothing.
 *
 * An ALLOWLIST of schemes. `javascript:` and `data:` are script on this origin, and this
 * origin serves every transcript the fleet has ever produced. A relative path is allowed
 * because that is what the pages' own links are; anything else must name a scheme this
 * function knows.
 */
export const safeUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  return scheme === "http" || scheme === "https" ? trimmed : undefined;
};
