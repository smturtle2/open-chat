import { getAuthToken } from "./auth.js";

// Deliberate CLI action; the server never writes the access token to logs.
process.stdout.write(getAuthToken() + "\n");
