/**
 * The read-only git proxy's answer to `git push` (receive-pack), as git shows it.
 *
 * Over smart HTTP, git prints a failed request's body only when it is `text/plain`: each line as
 * `remote: <line>`, then `fatal: unable to access '<url>': The requested URL returned error: 403`
 * (remote-curl.c `show_http_message`). A JSON body is dropped, so the agent would see a bare 403.
 * The text carries the `push-to-main` fix from @app/conventions, and the response repeats it as
 * JSON in the `x-gittifacts-error` header for clients that read headers rather than text.
 *
 * Node-safe (no Worker imports): test-node runs a real `git push` against it.
 */
import { fixFor } from "@app/conventions";

export const PUSH_FORK_COMMAND =
  'git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>';

/** The 403 for receive-pack on `/git/<owner>/<repo>.git` (or a Change's read-only fork path). */
export function receivePackRefusal(opts: { host: string; changeId: string | null }): Response {
  const host = opts.host.replace(/\/+$/, "");
  const fix =
    opts.changeId === null
      ? fixFor("push-to-main", { host })
      : {
          explanation:
            "This is a read-only mirror of the Change's fork. Push to the fork remote itself: refresh_push_token returns its url, token and branch.",
          call: `refresh_push_token({ changeId: "${opts.changeId}" })`,
          docsUrl: `${host}/start`,
        };
  const lines = [
    "gittifacts: push refused (push-to-main). This URL is read-only: integrations clone and fetch here, nothing pushes.",
    fix.explanation,
    ...(fix.call === undefined ? [] : [`Fix: ${fix.call}`]),
    `Then: ${PUSH_FORK_COMMAND}`,
    ...(fix.docsUrl === undefined ? [] : [`Docs: ${fix.docsUrl}`]),
  ];
  const header = JSON.stringify({
    code: "push-to-main",
    fix: { ...fix, command: PUSH_FORK_COMMAND },
  });
  return new Response(`${lines.join("\n")}\n`, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-gittifacts-error": header,
    },
  });
}
