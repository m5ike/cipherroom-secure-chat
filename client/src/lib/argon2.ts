// Only Argon2id from hash-wasm. A module of its own: the KDF worker is built
// as one file, where `await import("hash-wasm")` pulled in every algorithm
// the library has (216 kB); a static named import lets the bundler keep
// just this one.
export { argon2id } from "hash-wasm";
