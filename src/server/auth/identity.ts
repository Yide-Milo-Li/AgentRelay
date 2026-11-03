/** The person the hosting platform signed in, as this application sees them. Only `src/server/auth/` creates one. */
export type PlatformUser = {
  /** The platform's stable id for the person; it keys a private workspace and attributes records. */
  userId: string;
  /** Null when the platform did not report an email for this request. */
  email: string | null;
  /** The full name when known, else the email; null when neither was reported. */
  displayName: string | null;
  fullName: string | null;
};
