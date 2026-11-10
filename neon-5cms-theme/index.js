/**
 * Neon 5cm/s (霓虹秒速五厘米) — Host half.
 *
 * The whole feature lives in the browser half (`client.js`): the theme is
 * registered and activated through the official Client theme service, so the
 * Host only has to hold the Loader row that makes the bundle part of the
 * composition and lets the client module system serve `client.js`.
 *
 * Deliberately no `Config`: the plugin has no durable preferences of its own.
 * Switching the bundle off in Plugins removes the theme row, its stylesheet
 * and the petal rain, and the persisted light/dark/system preference applies
 * again.
 */

/** No Host-side work; the Loader row is the only thing this half provides. */
export function apply() {}
