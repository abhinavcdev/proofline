/**
 * Hashcash solver in an inline Web Worker (Blob URL), so the main thread never
 * blocks. Returns null if workers are unavailable (for example blocked by CSP)
 * or the budget runs out; the form still submits without a solution.
 */
const WORKER_SRC = `onmessage=async function(e){var s=e.data.salt,b=e.data.bits,t=new TextEncoder();for(var i=0;i<5e7;i++){var n=i.toString(36),h=new Uint8Array(await crypto.subtle.digest("SHA-256",t.encode(s+":"+n))),z=0;for(var j=0;j<h.length;j++){if(h[j]===0){z+=8;continue}z+=Math.clz32(h[j])-24;break}if(z>=b){postMessage(n);return}}postMessage(null)}`;

export function solveInWorker(salt: string, bits: number, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    let url: string | undefined;
    let worker: Worker | undefined;
    const done = (v: string | null) => {
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (e: MessageEvent<string | null>) => done(typeof e.data === "string" ? e.data : null);
      worker.onerror = () => done(null);
      worker.postMessage({ salt, bits });
    } catch {
      done(null);
    }
  });
}
