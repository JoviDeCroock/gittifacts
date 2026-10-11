/**
 * What a person came to sign in for, read from `/signin?next=…`: a claim link, an agent's consent
 * request, a CLI login or an integration install. The sign-in page says so ("Sign in to claim
 * time-api") instead of the generic pitch, because someone arriving from an agent's link may have
 * no account yet and should know what happens after. Pure: the screen fetches the claim's name.
 */

export type SigninPurpose =
  | { kind: "claim"; token: string }
  | { kind: "consent" }
  | { kind: "device" }
  | { kind: "install" }
  | { kind: "review" };

export function signinPurpose(next: string | undefined): SigninPurpose {
  if (!next) return { kind: "review" };
  let path: string;
  try {
    path = new URL(next, "https://x.invalid").pathname;
  } catch {
    return { kind: "review" };
  }
  const claim = /^\/claim\/([^/]+)$/.exec(path);
  if (claim?.[1]) return { kind: "claim", token: decodeURIComponent(claim[1]) };
  if (path === "/oauth/consent") return { kind: "consent" };
  if (path === "/device") return { kind: "device" };
  if (path === "/integrations/install") return { kind: "install" };
  return { kind: "review" };
}

export interface SigninCopy {
  title: string;
  lede: string;
}

/** The heading and lede for a purpose and mode; `repo` is the claim's name once it is known. */
export function signinCopy(p: SigninPurpose, mode: "signin" | "signup", repo?: string): SigninCopy {
  const verb = mode === "signin" ? "Sign in" : "Create an account";
  const back = "you'll come straight back.";
  switch (p.kind) {
    case "claim":
      return {
        title: `${verb} to claim ${repo ?? "this repo"}`,
        lede: `An agent made this repo and sent you the link. ${mode === "signin" ? "Sign in or create an account" : "Make an account"}; ${back}`,
      };
    case "consent":
      return {
        title: `${verb} to connect an agent`,
        lede: `An agent asked to act for you. ${mode === "signin" ? "Sign in" : "Make an account"} to see what it asks for; nothing is granted until you approve.`,
      };
    case "device":
      return {
        title: `${verb} to connect the CLI`,
        lede: `Your terminal is waiting. ${mode === "signin" ? "Sign in" : "Make an account"}, check the code matches, and choose what it may do.`,
      };
    case "install":
      return {
        title: `${verb} to install an integration`,
        lede: `An app asked to connect to your repositories. ${mode === "signin" ? "Sign in" : "Make an account"} to see what it asks for; nothing is installed until you approve.`,
      };
    case "review":
      return {
        title: mode === "signin" ? "Sign in to review" : "Create your account",
        lede: "Approve plans and read walkthroughs for the changes your agents write.",
      };
  }
}
