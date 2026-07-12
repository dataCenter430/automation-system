/** @type {import('next').NextConfig} */
export default {
  // The parser and status enums are shared with the worker via relative imports
  // outside this app dir; Next needs to be told that's intentional.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
};
