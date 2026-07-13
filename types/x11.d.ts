/**
 * The `x11` package ships no types.
 *
 * We use a five-line surface of it — createClient, then the client's InternAtom and SendEvent — in
 * exactly one file (apps/worker/src/util/x11.ts), which wraps it behind a typed API of our own. A
 * hand-written `any` declaration is more honest than pretending to type a protocol client we barely
 * touch, and it keeps the untyped surface confined to one module.
 */
declare module "x11";
