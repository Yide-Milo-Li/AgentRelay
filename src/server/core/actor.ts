/**
 * The authenticated caller. `owner` scopes every query; `userId` and `name` only attribute new records.
 * Without a shared workspace the owner is the user. In a shared workspace every member has the same access.
 */
/**
 * `connectionId` is the Agent connection the request authenticated with; it is absent for browser sessions.
 * `deviceId` is the registered device that connection is bound to (null when it is not bound); it labels the caller
 * and is what the reference `self` stands for. It never widens or narrows what the caller may do.
 */
export type Actor = { owner: string; userId: string; name: string | null; connectionId?: string; deviceId?: string | null };
