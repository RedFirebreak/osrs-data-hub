/**
 * Where the API reference page loads Scalar from (D-75): jsDelivr, an exact version, and the
 * Subresource Integrity hash of that exact file, so a changed or compromised CDN file is refused by
 * the browser. To upgrade: `npm view @scalar/api-reference version`, then recompute the hash with
 * `curl -sL <SCALAR_SRC> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */

/** `npm view @scalar/api-reference version` on 2026-09-29. */
export const SCALAR_VERSION = '1.72.2';

/** The browser bundle (what the package's unversioned jsDelivr URL redirects to). */
export const SCALAR_SRC = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;

/** sha384 of SCALAR_SRC; the same bytes as dist/browser/standalone.js in the npm tarball. */
export const SCALAR_INTEGRITY =
  'sha384-mc6GgHVwdYe1ZSU5XmJBa2pe6QzCRDSd0Pk8TqiqM7iiAOFMKtpBTOOa2RZDHkYN';

/**
 * Scalar's options besides `url`: no telemetry, no fonts from Scalar's servers, no AI agent or MCP
 * helpers, no developer toolbar; the document downloads as JSON.
 */
export const SCALAR_CONFIG: Readonly<Record<string, unknown>> = {
  telemetry: false,
  withDefaultFonts: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  showDeveloperTools: 'never',
  documentDownloadType: 'json',
};
