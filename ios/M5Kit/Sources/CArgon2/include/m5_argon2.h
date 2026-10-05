// Argon2id for M5Kit — the official PHC reference implementation
// (github.com/P-H-C/phc-winner-argon2, tag 20190702, CC0 1.0 / Apache 2.0,
// vendored unchanged in argon2/ except one include path), version 0x13.
// docs/ios-architecture.md § 2; room keys: 64 MiB, 3 passes, p = 1
// (client/src/lib/kdf.ts, android chat/Argon2.java).
#ifndef M5_ARGON2_H
#define M5_ARGON2_H
#include <stddef.h>
#include <stdint.h>

/// Argon2id (v 0x13) of `password` and `salt`: `out_len` bytes into `out`.
/// `m_cost_kib` is the memory in KiB, `t_cost` the passes. Returns 0 on
/// success, else a negative ARGON2_* error code.
int m5_argon2id(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len);

/// The same with the optional secret K and associated data X of RFC 9106
/// (NULL / 0 when absent) — for the RFC's test vector.
int m5_argon2id_ext(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                    const uint8_t *secret, size_t secret_len, const uint8_t *ad, size_t ad_len,
                    uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len);

#endif
