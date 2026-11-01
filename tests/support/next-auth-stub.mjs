// Auth service unit tests pass requests explicitly; server-component access must never be used by these tests.
export const headers = () => { throw new Error("Unexpected server-component headers call in a service test."); };
export const redirect = () => { throw new Error("Unexpected navigation in a service test."); };
