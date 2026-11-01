declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    AGENTRELAY_STORAGE_LIMIT_BYTES?: string;
    /** Platform user id whose workspace every signed-in viewer shares; unset keeps the site private per user. */
    AGENTRELAY_WORKSPACE_OWNER_ID?: string;
    BUCKET?: R2Bucket;
    AGENTRELAY_WEB_PUSH_ENABLED?: string;
    AGENTRELAY_VAPID_PUBLIC_KEY?: string;
    AGENTRELAY_VAPID_PRIVATE_KEY?: string;
    AGENTRELAY_VAPID_SUBJECT?: string;
  }
}
