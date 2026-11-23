// Surrogate client for the Secure Vault (authd).
//
// The LLM API keys live only in the Secure Vault. This module asks authd
// (over its unix socket) for an `hsurr:` surrogate reference and returns
// it; the runtime swaps the surrogate for the real key only on approved
// egress to the provider's registered host. The key value never appears
// in code, env, logs, or the repo. Mirrors
// /opt/muse/skills/custom-connector-setup/bin/dynamic_credentials.py
// (dynamic_credential_entry), reimplemented for Node.
import http from 'node:http';

const SOCK = process.env.JARVIS_AUTHD_SOCK || '/run/hatch/auth/authd.sock';

/**
 * Fetch the surrogate for a registered connector credential.
 * @param {string} credentialName e.g. 'custom.100milionseek'
 * @returns {Promise<{surrogate: string, placement: string|object}>}
 */
export function getSurrogate(credentialName) {
  const body = JSON.stringify({ name: credentialName });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCK,
        path: '/v1/credentials/surrogate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`authd HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const entry = (parsed.credentials || []).find((c) => c.name === 'access_token');
            const surrogate = String(entry?.surrogate || '').trim();
            if (!surrogate.startsWith('hsurr:')) {
              reject(new Error(`authd returned no surrogate for ${credentialName}`));
              return;
            }
            resolve({ surrogate, placement: entry.placement });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('authd timeout')));
    req.end(body);
  });
}
