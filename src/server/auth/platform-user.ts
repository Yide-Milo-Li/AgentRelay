import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";
import type { SignInProblem } from "@/shared/contracts/workspace";
import { AccessUnavailableError, accessUserFrom } from "./cloudflare-access";
import type { PlatformUser } from "./identity";
import { sitesSignInPath, sitesUserFrom } from "./sites-identity";

export const SIGN_IN_REQUIRED = DEPLOYMENT_TARGET === "cloudflare" ? "Sign in first." : "Sign in with ChatGPT first.";

/**
 * The platform-authenticated person behind a request, or null when the platform authenticated nobody. The build target
 * picks exactly one source: Sites identity headers, or a verified Cloudflare Access token. A `cloudflare` build never
 * reads the Sites headers, because nothing in front of it strips them from what a client sends.
 */
export async function platformUserFrom(requestHeaders: Headers): Promise<PlatformUser | null> {
  return DEPLOYMENT_TARGET === "cloudflare" ? accessUserFrom(requestHeaders) : sitesUserFrom(requestHeaders);
}

export async function getPlatformUser(): Promise<PlatformUser | null> {
  return platformUserFrom(await headers());
}

export type PageIdentity = { user: PlatformUser; problem?: undefined } | { user: null; problem: SignInProblem };

/**
 * Who the page renders for. On Sites, a request without a complete profile is sent to sign in. On a standalone
 * deployment Access signs people in before the Worker runs, so a missing person means Access is not in front of this
 * route, and missing settings or unreachable keys are the deployment's problem; the page explains which.
 */
export async function pageIdentity(returnTo: string): Promise<PageIdentity> {
  if (DEPLOYMENT_TARGET !== "cloudflare") {
    const user = await getPlatformUser();
    if (user?.email) return { user };
    redirect(sitesSignInPath(returnTo));
  }
  try {
    const user = await getPlatformUser();
    return user ? { user } : { user: null, problem: "signed-out" };
  } catch (error) {
    if (error instanceof AccessUnavailableError) return { user: null, problem: error.reason };
    throw error;
  }
}
