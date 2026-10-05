// Argon2id for M5Kit (placeholder: the crypto agent vendors the reference
// implementation here — docs/ios-architecture.md § 2).
#ifndef M5_ARGON2_H
#define M5_ARGON2_H
#include <stddef.h>
#include <stdint.h>
/// Returns 0 on success.
int m5_argon2id(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len);
#endif
