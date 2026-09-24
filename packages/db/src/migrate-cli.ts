import { createPostgresStore } from "./node.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const { close } = await createPostgresStore(url, { migrate: true });
await close();
console.warn("migrations applied");
