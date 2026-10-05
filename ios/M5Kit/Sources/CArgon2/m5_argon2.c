// M5Kit's entry points into the vendored Argon2 reference implementation
// (argon2/: P-H-C phc-winner-argon2 20190702, CC0 1.0 / Apache 2.0 — each file
// keeps its licence header). Only `argon2/blake2/blake2.h` was touched: its
// `#include <argon2.h>` became a relative include, so the vendored header is
// not a public header of this module.
#include "m5_argon2.h"
#include "argon2/argon2.h"

int m5_argon2id(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len) {
  return m5_argon2id_ext(password, password_len, salt, salt_len, NULL, 0, NULL, 0, t_cost, m_cost_kib, parallelism, out, out_len);
}

int m5_argon2id_ext(const uint8_t *password, size_t password_len, const uint8_t *salt, size_t salt_len,
                    const uint8_t *secret, size_t secret_len, const uint8_t *ad, size_t ad_len,
                    uint32_t t_cost, uint32_t m_cost_kib, uint32_t parallelism, uint8_t *out, size_t out_len) {
  if (out == NULL || out_len > UINT32_MAX || password_len > UINT32_MAX || salt_len > UINT32_MAX || secret_len > UINT32_MAX || ad_len > UINT32_MAX) {
    return ARGON2_INCORRECT_PARAMETER;
  }
  argon2_context ctx;
  ctx.out = out;
  ctx.outlen = (uint32_t)out_len;
  ctx.pwd = (uint8_t *)password;
  ctx.pwdlen = (uint32_t)password_len;
  ctx.salt = (uint8_t *)salt;
  ctx.saltlen = (uint32_t)salt_len;
  ctx.secret = (uint8_t *)secret;
  ctx.secretlen = (uint32_t)secret_len;
  ctx.ad = (uint8_t *)ad;
  ctx.adlen = (uint32_t)ad_len;
  ctx.t_cost = t_cost;
  ctx.m_cost = m_cost_kib;
  ctx.lanes = parallelism;
  ctx.threads = parallelism;
  ctx.allocate_cbk = NULL;
  ctx.free_cbk = NULL;
  ctx.flags = ARGON2_DEFAULT_FLAGS;
  ctx.version = ARGON2_VERSION_13;
  return argon2_ctx(&ctx, Argon2_id);
}
