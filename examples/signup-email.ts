import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { sendEmail } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// The request handler. The user row and the job commit together.
export async function signUp(email: string, name: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [user] = await tx`insert into users (email, name) values (${email}, ${name}) returning id::text as id`;
    await treadle.enqueue(tx, "welcome-email", { userId: user!.id }, {
      idempotencyKey: `welcome:${user!.id}`,
    });
    return user!.id as string;
  });
}

// The worker. Runs in the same process or a separate one.
const worker = new Worker(sql, { queues: ["default"] });
worker.register("welcome-email", async (args: { userId: string }) => {
  const [user] = await sql`select email, name from users where id = ${args.userId}`;
  if (!user) return; // deleted before the email went out; nothing to do
  await sendEmail(user.email, "welcome", { name: user.name });
});
await worker.start();
