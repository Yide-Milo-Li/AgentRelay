/** What the page can observe about the browser; a plain object so the rules stay testable without a DOM. */
export type NotificationEnvironment = {
  secureContext: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean;
  /** `navigator.brave` exists in Brave, which reports a Chrome brand but blocks Google's push service by default. */
  brave?: boolean;
  userAgentData?: { mobile: boolean; platform?: string; brands: { brand: string }[] } | null;
};
export type NotificationSupport =
  | { supported: true; browser: "Chrome" | "Edge"; label: string }
  | { supported: false; reason: "mobile" | "browser" | "api" };

const PHONE_PLATFORMS = new Set(["Android", "iOS"]);
const BRANDS = [["Microsoft Edge", "Edge"], ["Google Chrome", "Chrome"]] as const;

/**
 * Browser notifications are verified on desktop Chrome and desktop Edge only, so every other browser is told so rather
 * than offered a feature that has not been tested there. This is a product limit, not a security boundary: the
 * server separately accepts only the push services those two browsers use.
 */
export function notificationSupport(environment: NotificationEnvironment): NotificationSupport {
  const data = environment.userAgentData;
  // Firefox and Safari expose no brand list, and the user-agent string cannot tell Chromium forks apart.
  const match = data && !environment.brave ? BRANDS.find(([brand]) => data.brands.some(item => item.brand === brand)) : undefined;
  if (!data || !match) return { supported: false, reason: "browser" };
  // Android tablets report `mobile: false`, so the platform decides as well.
  if (data.mobile || PHONE_PLATFORMS.has(data.platform ?? "")) return { supported: false, reason: "mobile" };
  if (!environment.secureContext || !environment.serviceWorker || !environment.pushManager || !environment.notification) return { supported: false, reason: "api" };
  return { supported: true, browser: match[1], label: labelFor(match[1], data.platform) };
}

/** A short display label such as "Chrome on Windows"; the platform string is untrusted display text. */
function labelFor(browser: string, platform: string | undefined) {
  const clean = (platform ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 20);
  return clean ? `${browser} on ${clean}` : browser;
}

/** Reads the running browser. Call only in the browser, after hydration. */
export function currentNotificationEnvironment(): NotificationEnvironment {
  const nav = navigator as Navigator & { brave?: unknown; userAgentData?: NotificationEnvironment["userAgentData"] };
  return {
    secureContext: window.isSecureContext, serviceWorker: "serviceWorker" in navigator, pushManager: "PushManager" in window,
    notification: "Notification" in window, brave: nav.brave !== undefined, userAgentData: nav.userAgentData ?? null,
  };
}
