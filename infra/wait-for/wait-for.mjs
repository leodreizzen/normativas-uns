// Blocks until every given postgres:// or redis:// URL is ready to serve queries.
// After an unclean host restart Docker restarts all containers at once, ignoring
// depends_on, so web/worker must wait for the db themselves. A plain TCP check is
// not enough: Postgres accepts connections during crash recovery and Redis while
// loading the AOF, so we speak just enough of each protocol to tell them apart.
import net from "node:net";

const TIMEOUT_MS = Number(process.env.WAIT_FOR_TIMEOUT_MS ?? 180_000);
const RETRY_MS = 1000;

// Same semantics as pg_isready: any reply other than "cannot connect now" means
// the server is up (auth errors included).
function pgStartupMessage(url) {
    const user = decodeURIComponent(url.username) || "postgres";
    const database = decodeURIComponent(url.pathname.slice(1)) || user;
    const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
    const msg = Buffer.alloc(8 + params.length);
    msg.writeInt32BE(msg.length, 0);
    msg.writeInt32BE(196608, 4); // protocol 3.0
    params.copy(msg, 8);
    return msg;
}

function pgIsReady(reply) {
    const type = String.fromCharCode(reply[0]);
    if (type !== "E") return type === "R" || type === "v";
    for (let i = 5; i < reply.length && reply[i] !== 0;) {
        const end = reply.indexOf(0, i + 1);
        if (end === -1) break;
        if (reply[i] === "C".charCodeAt(0)) return reply.toString("utf8", i + 1, end) !== "57P03";
        i = end + 1;
    }
    return false;
}

// Without credentials Redis answers -NOAUTH once it is up, -LOADING while restoring.
function redisIsReady(reply) {
    return !reply.toString().startsWith("-LOADING");
}

function check(url) {
    const isPg = url.protocol.startsWith("postgres");
    const port = Number(url.port) || (isPg ? 5432 : 6379);
    return new Promise((resolve) => {
        const socket = net.connect({host: url.hostname, port});
        const done = (ready) => {
            socket.destroy();
            resolve(ready);
        };
        socket.setTimeout(3000, () => done(false));
        socket.on("error", () => done(false));
        socket.on("connect", () => socket.write(isPg ? pgStartupMessage(url) : "PING\r\n"));
        socket.once("data", (reply) => done(isPg ? pgIsReady(reply) : redisIsReady(reply)));
    });
}

const deadline = Date.now() + TIMEOUT_MS;
for (const raw of process.argv.slice(2).filter(Boolean)) {
    const url = new URL(raw);
    while (!(await check(url))) {
        if (Date.now() > deadline) {
            console.error(`wait-for: timed out waiting for ${url.host}`);
            process.exit(1);
        }
        console.log(`wait-for: waiting for ${url.host}...`);
        await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    console.log(`wait-for: ${url.host} is ready`);
}
