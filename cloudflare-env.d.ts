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
    /** Standalone deployments only: the Access team domain, `https://<team>.cloudflareaccess.com`. */
    AGENTRELAY_ACCESS_TEAM_DOMAIN?: string;
    /** Standalone deployments only: comma-separated AUD tags of the Access applications in front of this Worker. */
    AGENTRELAY_ACCESS_AUD?: string;
    /** Optional override of where Access signing keys are fetched; HTTPS, or HTTP on loopback for tests. */
    AGENTRELAY_ACCESS_CERTS_URL?: string;
  }
}
