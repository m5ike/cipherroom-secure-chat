// Loads `.env` from the working directory via Node's built-in parser
// (process.loadEnvFile, Node >= 20.12) — replaces the `dotenv` package.
//
// Must be the FIRST import of every entry point: other modules read
// process.env at evaluation time (push.ts, events.ts, ...).
//
// Same precedence as dotenv: variables already present in the real
// environment (Docker, systemd EnvironmentFile, CI) win over the file.
// A missing .env is normal in containers and is ignored; any other failure
// (unreadable file, parse error) is surfaced rather than silently booting
// with half a configuration.

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
