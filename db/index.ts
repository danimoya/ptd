
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { createPool } from "./connection";

const client = createPool();
export const db = drizzle(client, { schema });
