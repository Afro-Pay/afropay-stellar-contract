export const API_PORT = 8081;
export const APP_PORT = 5183;

export const API_BASE_URL = `http://localhost:${API_PORT}`;
export const APP_BASE_URL = `http://localhost:${APP_PORT}`;

/** Matches the shared-secret JWT_SECRET the API webServer is started with (see playwright.config.ts). */
export const JWT_SECRET = "e2e-test-jwt-secret-not-for-production-use";

/** A syntactically valid Stellar G-address, used as the SEP-10 `sub` in test JWTs. */
export const TEST_ACCOUNT = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
