// Şəxsi, daxili və xüsusi təyinatlı IP aralıqları (SSRF qoruması üçün).
import net from "node:net";

function ipv4Private(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||              // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||    // CGNAT
    (a === 192 && b === 0 && c === 0) ||     // 192.0.0.0/24 (IETF protokol təyinatları)
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (benchmark şəbəkələri)
    a >= 224;                                // multicast və ehtiyat
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const l = ip.toLowerCase();
  if (l === "::1" || l === "::") return true;
  if (l.startsWith("::ffff:")) {
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? ipv4Private(m[1]) : true; // hex formasını ehtiyat üçün blokla
  }
  if (l.startsWith("64:ff9b:")) return true; // NAT64: içində istənilən IPv4 gizlənə bilər
  return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l);
}
