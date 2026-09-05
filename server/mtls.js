import crypto from 'crypto';

// Constant-time string compare that tolerates unequal lengths.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still spend the compare to avoid trivial length oracles.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function normFingerprint(fp) {
  return fp ? String(fp).replace(/:/g, '').toLowerCase() : null;
}

function subjectOf(cert) {
  if (!cert) return null;
  if (cert.subject && cert.subject.CN) return cert.subject.CN;
  if (cert.subjectaltname) return cert.subjectaltname;
  if (cert.subject && typeof cert.subject === 'object') {
    const parts = Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`);
    if (parts.length) return parts.join(',');
  }
  return null;
}

// Resolve the verified client identity for a request, or null if the request
// is not authenticated by a trusted client certificate. Fail-closed: any
// missing/ambiguous signal returns null.
//
// Two modes (see server/config.js):
//   'direct' — CARMA terminated TLS with requestCert; the socket has already
//              verified the peer cert chains to CAPABILITY_CLIENT_CA
//              (socket.authorized === true).
//   'proxy'  — a trusted TLS-terminating proxy verified the client cert and
//              forwarded the identity via headers; only trusted when the
//              request carries the matching shared secret.
export function clientIdentity(req, config) {
  const id = config.mtlsMode === 'proxy' ? proxyIdentity(req, config) : directIdentity(req);
  if (!id) return null;
  // Optional fingerprint pinning: when configured, the presented fingerprint
  // must be in the allow-list. If pinning is on but no fingerprint is
  // available, reject (fail-closed).
  const pins = config.capabilityTrustedFingerprints || [];
  if (pins.length) {
    const fp = normFingerprint(id.fingerprint);
    if (!fp || !pins.includes(fp)) return null;
  }
  return id;
}

function directIdentity(req) {
  const socket = req.socket;
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  // `authorized` is only true when the peer presented a cert that chained to a
  // configured CA. Without requestCert/ca it is false, so this fails closed.
  if (!socket.authorized) return null;
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return null;
  const subject = subjectOf(cert);
  if (!subject) return null;
  return { subject: String(subject), fingerprint: normFingerprint(cert.fingerprint256 || cert.fingerprint), mode: 'direct' };
}

function proxyIdentity(req, config) {
  if (!config.mtlsProxySecret) return null;
  const presented = req.headers[config.mtlsProxySecretHeader];
  if (!presented || !safeEqual(presented, config.mtlsProxySecret)) return null;
  // If the proxy reports its own verification result, it must be a success.
  const verify = req.headers[config.mtlsProxyVerifyHeader];
  if (verify != null && String(verify).toUpperCase() !== 'SUCCESS') return null;
  const subject = req.headers[config.mtlsProxySubjectHeader];
  if (!subject) return null;
  const fingerprint = req.headers[config.mtlsProxyFingerprintHeader] || null;
  return { subject: String(subject), fingerprint: normFingerprint(fingerprint), mode: 'proxy' };
}
