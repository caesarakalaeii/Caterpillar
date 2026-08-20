/**
 * The one address shape that must never author anything the fleet writes. See §9.7.
 *
 * A module of its own because the rule is enforced in two places for two different
 * reasons, and a rule copied is a rule that drifts:
 *
 *   `config/load.ts`      refuses it in the ConfigMap, so a runner told to be a stranger
 *                         does not start.
 *   `workspace/toolchain.ts`  refuses it in the environment every task shell is handed,
 *                         which is the last point before it becomes history.
 *
 * The second is not the first one twice. An identity can reach a commit without passing
 * through the loader — a machine runner inherits the operator's `GIT_AUTHOR_EMAIL`, a
 * caller can construct the resolver by hand — and the loader cannot see any of that.
 */

/**
 * GitHub's noreply domain. An address here is not decoration — it RESOLVES to an account.
 */
export const GITHUB_NOREPLY = "@users.noreply.github.com";

/** The unambiguous form: `<id>+<login>@users.noreply.github.com`. */
const ID_PREFIXED = /^\d+\+/;

/**
 * Why this address must not author commits, or `undefined` when it may.
 *
 * The refused shape is a github noreply address WITHOUT the numeric id prefix. This is not
 * pedantry, it is the defect the rule was written after.
 * `caterpillar@users.noreply.github.com` reads like a reserved, inert address for a
 * project called caterpillar; it is in fact the pre-2017 personal noreply form, and GitHub
 * resolves it to the account holding that login. An unrelated person spent a hundred and
 * twenty-nine commits as the author of this fleet's work, on their contribution graph,
 * with their avatar, in repositories they have never seen. The id-prefixed form cannot do
 * that: a numeric id names exactly one account, so it is either yours or it does not
 * exist.
 *
 * Only that domain is checked. A runner pushing to Codeberg has no github noreply address
 * to get wrong and must not be made to invent an id prefix that means nothing there.
 *
 * A message rather than a boolean, so the two callers refuse in the same words and only
 * the sentence naming WHERE it came from differs.
 */
export const identityFault = (email: string): string | undefined => {
  if (!email.includes("@")) return `'${email}' is not an email address`;

  if (email.endsWith(GITHUB_NOREPLY) && !ID_PREFIXED.test(email)) {
    return (
      `'${email}' is a bare users.noreply.github.com address, which GitHub resolves to the ` +
      `account with that login — it would attribute this runner's commits to whoever owns ` +
      `it. Use the id-prefixed form '<id>+<login>@users.noreply.github.com'; for a GitHub ` +
      `App the id is that of '<slug>[bot]' (GET /users/<slug>%5Bbot%5D)`
    );
  }

  return undefined;
};
