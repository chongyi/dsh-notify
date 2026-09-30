/**
 * dsh-notify — host half (no-op).
 *
 * Everything this plugin does lives in the browser half (lib/client.js):
 * desktop notifications, sounds and a tab-title marker when the agent needs
 * the user's input or a reply finishes. This module exists only so the loader
 * entry mounts the package, letting dsh-client-modules pick up the dsh.client
 * declaration and serve /plugins/dsh-notify/client.js to the page.
 */

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-notify";

/**
 * Host loader entry: nothing to mount on the server side.
 * @param ctx - host cordis context.
 */
export function apply() {}
