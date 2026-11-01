// DNS rebinding-ə qarşı qoruma: IP ünvanı QOŞULMA ANINDA yoxlanır.
// assertSafeUrl domeni əvvəlcədən yoxlayır, amma adi fetch domeni yenidən resolve edir; hücumçu
// TTL=0 ilə ikinci cavabda 127.0.0.1 və ya 169.254.169.254 qaytara bilər. Bu modul resolve olunan
// həmin IP-nin özünü yoxlayır, ona görə yoxlanan və qoşulan ünvan eyni olur.
import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { isPrivateIp } from "./ipCheck.js";

const localAllowed = () => process.env.ALLOW_LOCAL_CONNECTORS === "1";

/** net.connect / tls.connect üçün lookup: şəxsi və ya daxili IP-yə resolve olunsa qoşulmur. */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length) return callback(Object.assign(new Error(`Ünvan tapılmadı: ${hostname}`), { code: "ENOTFOUND" }));
    if (!localAllowed() && addrs.some((a) => isPrivateIp(a.address)))
      return callback(Object.assign(new Error("Daxili şəbəkə ünvanlarına icazə yoxdur"), { code: "EPRIVATEIP" }));
    if (options?.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup } });

/** fetch ilə eynidir, amma hər qoşulmada IP yoxlanır. */
export const guardedFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: agent });

/** Xəta EPRIVATEIP-dirsə true (çağıran aydın mesaj göstərə bilər). */
export const isPrivateIpError = (e) => e?.cause?.code === "EPRIVATEIP" || e?.code === "EPRIVATEIP";
