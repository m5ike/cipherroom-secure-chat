// Protocol 4 (M5cet 6.12) — the reference library's public API. The normative
// text is docs/protocol-v4.md; constants and wire shapes are in contract.ts.

export * from "./contract";
export * from "./merkle";
export {
  P4Error, type P4ErrorCode, type Bytes, type P256Pair, type DeviceSigner,
  join, joinText, H, hB64, hmac, hkdf, keyIv, b64, unb64, b64url, unb64url, hex, ctEqual, concat, utf8, fromUtf8,
  aesGcmSeal, aesGcmOpen, ecdh, ecdsaSign, ecdsaVerify, importEcdhPublic, importP256Pkcs8, isP256Spki,
  ed25519FromSeed, ed25519Sign, ed25519Verify, ECDH_P256, ECDSA_P256,
} from "./primitives";
export { type Rng, type TapeEntry, systemRng, RecordingRng, TapeRng } from "./rng";
export { pad, unpad, paddedLength } from "./pad";
export { type KemKeyPair, kemKeygen, kemKeygenFromSeed, kemEncaps, kemEncapsWith, kemDecaps, kemKid } from "./kem";
export {
  type HelloV4, type HelloV3Part, type HelloSecrets, type HelloVerdict, type BuildHelloOptions, type Party, type PairSession,
  type EstablishInput, type PairHandshakeOptions,
  buildHello, verifyHello, verifyAccount, certifyDeviceV2, helloSig4Data, mbDigest, accDigest, helloRef,
  buildKemMessage, openKemMessage, roleOf, transcriptHash, rootSchedule, establishSession, PairHandshake,
} from "./handshake";
export {
  type RatchetInit, type RatchetInfo, type RatchetResult, type RatchetFailure, type RatchetOpened, type RatchetRole,
  Ratchet, kdfRk, kdfCk, pairAad, headerParts, parseInner,
} from "./ratchet";
export { type SkInner, SenderKeys4, senderKeyAad, skCertData, p4Signer } from "./sender-keys4";
export {
  type BundleKeys, type BundleStore, type SealInput, type OpenedMailboxItem,
  MemoryBundleStore, Mailbox, createBundle, bundleSignedData, checkBundle, isBundleShape, mailboxAad,
  sealMailboxItem, openMailboxItem, mailboxSet, isMailboxItem, isMailboxSet,
} from "./mailbox";
export { type MediaInner, MEDIA_FRAME_LIMIT, frameIv, ivEpoch, newMediaKey, importMediaKey, MediaSender, MediaReceiver, sealedFrameIv } from "./media4";
export { type FileInner, newFileKey, fileKeyBytes, fileKey4, fileAad4, sealFileBody4, openFileBody4, sealChunk4, openChunk4 } from "./files4";
export { hubSeed, hubKeyPair, hubJoinData, buildHubProof, verifyHubProof } from "./hub-proof";
export {
  type VerifiedEntry, type KtAlert, type KtOriginState, type KtStore, type KtUpdate, type KtGossip, type ConsistencyFetcher,
  canonicalEntry, ktUser, entryLeafHash, sthData, isSth, signSth, verifySth, verifyLookup, deviceStatus, MemoryKtStore, KtState,
} from "./kt";
export { type ReplayStore, type ReplayVerdict, replayKey, MemoryReplayStore, ReplayGuard } from "./replay";
export { RELEASE_FORMAT, isReleasePath, parseReleaseManifest, verifyReleaseSignature, sha256Hex, checkReleaseFiles } from "./release";
