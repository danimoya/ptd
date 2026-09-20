/**
 * Terminal prompts, written by hand so the package keeps zero runtime
 * dependencies.
 *
 * `askSecret` turns the TTY to raw mode and echoes nothing — a password must not
 * end up in the scrollback. When stdin is not a TTY both helpers read one line,
 * so `printf 'pw\n' | ptd login --email …` works in a pipeline.
 */
import { createInterface } from "node:readline";

export async function ask(question: string, { secret = false } = {}): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();
  return secret ? readHidden(question) : readVisible(question);
}

export function askSecret(question: string): Promise<string> {
  return ask(question, { secret: true });
}

function readVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch < " ") continue;
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readPipedLine(): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buffer.slice(0, newline).trim());
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", () => resolve(buffer.trim()));
    process.stdin.resume();
  });
}
