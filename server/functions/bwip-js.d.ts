// bwip-js ships no bundled type declarations; only the two calls we use.
declare module "bwip-js" {
  const bwipjs: {
    toSVG(opts: Record<string, unknown>): string;
    toBuffer(opts: Record<string, unknown>): Promise<Uint8Array>;
  };
  export default bwipjs;
}
