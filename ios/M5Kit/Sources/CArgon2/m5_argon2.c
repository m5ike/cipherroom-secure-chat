#include "m5_argon2.h"
// Placeholder until the reference implementation is vendored (returns an error).
int m5_argon2id(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len) {
  (void)password; (void)password_len; (void)salt; (void)salt_len; (void)t_cost; (void)m_cost_kib; (void)parallelism; (void)out; (void)out_len;
  return -1;
}
